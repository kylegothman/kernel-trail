import type { EmittableEvent } from '../EventBus';
import type { ThreadControlBlock } from '../process/threads';
import type {
  BlockId, BlockReason, Device, DeviceId, IoMode, IoSnapshotActor, IoSnapshotBuffer, IoSnapshotDevice,
  IoSnapshotInterruptToken, IoSnapshotRequest, IoSnapshotResult, IoSnapshotState, KernelSnapshot,
  Pid, ProcessControlBlock, Rng, StorageConsumerSnapshot, StorageRequestSnapshot, StorageTransferSnapshot, SyscallResult, Tick, Tid,
} from '../types';
import { BlockCache } from './blockCache';
import type { CacheFlush } from './blockCache';
import { DeviceBuffer } from './buffering';
import { InterruptController } from './InterruptController';
import { continuation, transferTicks } from './modes';
import { Spooler } from './spool';
import { bytesFor, check, compareText, failure, plainData, success, validInteger } from './drivers/DeviceDriver';
import type { DeviceDriver, IoContext, Mutable } from './drivers/DeviceDriver';
import { disk0Driver } from './drivers/disk0';
import { nvm0Driver } from './drivers/nvm0';
import { characterOutputDriver } from './drivers/characterOutput';
import { net0Driver } from './drivers/net0';

export type IoSettings = IoSnapshotState['payload']['settings'];
export type IoStorageTarget = { readonly kind: 'disk'; readonly driveId: string }
  | { readonly kind: 'nvm'; readonly deviceId: DeviceId } | { readonly kind: 'raid'; readonly arrayId: string };
export interface IoStorage {
  submit(target: IoStorageTarget, transfer: StorageTransferSnapshot, consumer: StorageConsumerSnapshot, pid: Pid | null): number;
  deviceTarget(device: DeviceId): IoStorageTarget | null;
  peekCompletion(id: number): StorageRequestSnapshot['completion'];
  takeCompletion(id: number): StorageRequestSnapshot['completion'];
  cancel(id: number): void;
  control?(device: DeviceId, command: string, args: readonly (string | number | boolean)[], pid?: Pid | null): SyscallResult;
}
export interface IoHost {
  tick(): Tick;
  enabled(): boolean;
  settings(): IoSettings;
  process(pid: Pid): ProcessControlBlock | undefined;
  thread(tid: Tid): Pick<ThreadControlBlock, 'pid' | 'tid' | 'state' | 'blockedOn'> | undefined;
  actor(pid: Pid): IoSnapshotActor | undefined;
  block(actor: IoSnapshotActor, device: DeviceId): void;
  emit(event: EmittableEvent): void;
  terminate(pid: Pid, reason: 'io_timeout'): void;
  chargeKernelDebt(ticks: number): void;
  abortStorage?(): void;
  onRequestSubmitted?(request: IoSnapshotRequest): void;
  onRequestRemoved?(request: IoSnapshotRequest): void;
  onRequestCompleted?(request: IoSnapshotRequest, result: IoSnapshotResult): void;
}
export type IoControlExtension = (device: DeviceId, command: string,
  args: readonly (string | number | boolean)[], actor: IoSnapshotActor | undefined) => SyscallResult | undefined;
const asDeviceId = (value: string): DeviceId => value as DeviceId;
const asBlockId = (value: number): BlockId => value as BlockId;
type Payload = IoSnapshotState['payload'];
type Request = Mutable<IoSnapshotRequest>;
const sameActor = (a: IoSnapshotActor, b: IoSnapshotActor): boolean => a.pid === b.pid && a.tid === b.tid;
const modeValid = (mode: unknown): mode is IoMode => mode === 'polling' || mode === 'interrupt' || mode === 'dma';

export class IoSubsystem {
  readonly devices: Device[] = [];
  readonly interrupts: InterruptController;
  readonly cache: BlockCache;
  readonly spool: Spooler;
  private readonly drivers = new Map<DeviceId, DeviceDriver>();
  private readonly controlExtensions = new Set<IoControlExtension>();
  private readonly buffers = new Map<DeviceId, DeviceBuffer>();
  private data: Mutable<Payload>;
  private inDelivery = false;
  private controlActor: IoSnapshotActor | undefined;
  private readonly context: IoContext;
  constructor(private readonly host: IoHost, readonly rng: Rng, private readonly storage?: IoStorage) {
    this.data = { tick: host.tick(), settings: { ...host.settings() }, nextRequestId: 1, nextInterruptTokenId: 1, nextFlushId: 1,
      nextSyncId: 1, nextSpoolJobId: 1, lastTimerTick: null, lastCompletionTick: null, kernelDebt: 0, pendingKernelCharges: [],
      cpuCharges: { issueTicks: 0, interruptTicks: 0, copyTicks: 0, dmaStealTicks: 0 }, pollTicks: [], devices: [], requests: [],
      interrupts: { lines: [], masks: [], serviceStack: [], budgetTick: null, deliveredThisTick: 0, lastStormSampleTick: null, storm: null },
      buffers: [], cache: { policy: 'write_through', nextGeneration: 1, hits: 0, misses: 0, entries: [], flushes: [], admissions: [], syncs: [] }, spools: [] };
    this.interrupts = new InterruptController({ tick: () => host.tick(), settings: () => host.settings(), nextToken: () => this.data.nextInterruptTokenId++,
      source: token => this.tokenPid(token), handle: (device, token) => this.handleToken(device, token),
      charge: (device, token, ticks) => this.charge('interrupt', device, token.kind === 'completion' ? token.requestId : null, ticks),
      emit: event => host.emit(event), mitigate: device => this.mitigate(device), terminate: pid => host.terminate(pid, 'io_timeout') });
    this.cache = new BlockCache({ tick: () => host.tick(), capacity: () => host.settings().blockCacheEntries,
      nextFlush: () => this.data.nextFlushId++, nextSync: () => this.data.nextSyncId++,
      submit: flush => this.submitFlush(flush), take: flush => {
        if (flush.progress.kind === 'storage') return this.storage?.takeCompletion(flush.progress.storageRequestId)?.result ?? null;
        if (flush.progress.kind === 'io') { const result = this.takeResult(flush.progress.requestId); return result?.kind === 'lost' ? { kind: 'failed', reason: 'device_failed' } : result; }
        return null;
      }, cancel: flush => {
        if (flush.progress.kind === 'storage') this.storage?.cancel(flush.progress.storageRequestId);
        if (flush.progress.kind === 'io') this.cancelRequest(flush.progress.requestId);
      }, block: (actor, device) => host.block(actor, device) });
    this.spool = new Spooler({ tick: () => host.tick(), nextJob: () => this.data.nextSpoolJobId++, emit: event => host.emit(event),
      output: (device, bytes) => this.output(device, bytes), complete: job => {
        if (job.requestId !== null) { const req = this.find(job.requestId); if (req !== undefined) this.mediaDone(req, { kind: 'ok', data: [] }); }
      } });
    this.context = { rng, tick: () => host.tick(), state: device => this.deviceState(device), start: req => this.start(this.requireRequest(req.id)),
      result: req => req.service.kind === 'completed' ? req.service.result : { kind: 'ok', data: [] },
      complete: (req, result) => this.finishMedia(this.requireRequest(req.id), result), output: (device, bytes) => this.output(device, bytes),
      interrupt: () => {}, control: (device, command, args) => this.driverControl(device, command, args) };
    const diskTarget = storage?.deviceTarget(asDeviceId('disk0')) ?? null;
    const nvmTarget = storage?.deviceTarget(asDeviceId('nvm0')) ?? null;
    this.addDevice(asDeviceId('disk0'), 'Disk', 20, 'interrupt', 64,
      { kind: 'disk0', backing: diskTarget?.kind === 'disk' || diskTarget?.kind === 'raid' ? diskTarget : null }, 5);
    this.addDevice(asDeviceId('nvm0'), 'Nonvolatile memory', 1, 'dma', 64,
      { kind: 'nvm0', backing: nvmTarget?.kind === 'nvm' ? { deviceId: nvmTarget.deviceId } : null }, 5);
    this.addDevice(asDeviceId('tty0'), 'Character output', 1, 'interrupt', 1, { kind: 'character_output', output: [] }, 10);
    this.addDevice(asDeviceId('net0'), 'Network', 20, 'interrupt', 64, { kind: 'net0', lossProbability: 0 }, 8);
    this.interrupts.register(asDeviceId('timer'), 0, false); this.interrupts.register(asDeviceId('kernel.panic'), 0, false);
  }
  get debt(): number { return this.data.kernelDebt; }
  get cpuCharges(): Payload['cpuCharges'] { return { ...this.data.cpuCharges }; }
  consumeDebtTick(): void { check(this.data.kernelDebt > 0, 'empty kernel debt'); this.data.kernelDebt -= 1; }
  pollTicks(pid: Pid): number { return this.data.pollTicks.find(row => row.pid === pid)?.ticks ?? 0; }
  stormState(): { active: boolean; device: DeviceId | null; ticksHeld: number } { return this.interrupts.stormState(); }
  mode(device: DeviceId): IoMode { return this.deviceState(device).mode; }
  bindStorage(deviceId: DeviceId, target: IoStorageTarget | null): SyscallResult {
    const device = this.deviceState(deviceId);
    if (this.data.requests.some(req => req.device === deviceId) || this.cache.snapshot().flushes.some(flush => flush.device === deviceId)) return { ok: false, errno: 'EBUSY', message: 'device has pending work' };
    if (device.driver.kind === 'disk0' && (target === null || target.kind === 'disk' || target.kind === 'raid')) device.driver.backing = target === null ? null : { ...target };
    else if (device.driver.kind === 'nvm0' && (target === null || target.kind === 'nvm')) device.driver.backing = target === null ? null : { deviceId: target.deviceId };
    else return failure('incompatible storage target');
    this.cache.invalidate(deviceId); return success();
  }
  registerTimerDevice(options: { id: DeviceId; latency: number; mode?: IoMode; wordSize?: number; priority?: number }): void {
    this.addDevice(options.id, 'Timed device', options.latency, options.mode ?? 'interrupt', options.wordSize ?? 64, { kind: 'timer_fixture' }, options.priority ?? 10);
  }
  registerPrinter(device: DeviceId, spooled = true): void {
    this.addDevice(device, 'Printer', 1, 'interrupt', 1, { kind: 'printer_fixture', output: [] }, 10); this.spool.configure(device, spooled);
  }
  configureBuffer(device: DeviceId, scheme: IoSnapshotBuffer['scheme'], producerTicks = 1, consumerTicks = 1): DeviceBuffer {
    this.deviceState(device);
    const buffer = new DeviceBuffer(device, scheme, { contents: id => {
      const req = this.requireRequest(id); return req.command.kind === 'read' ? Array.from({ length: req.command.bytes }, () => 0) : req.command.contents;
    }, consumed: id => { const req = this.find(id); if (req !== undefined) this.mediaDone(req, { kind: 'ok', data: [] }); } }, producerTicks, consumerTicks);
    this.buffers.set(device, buffer); return buffer;
  }
  submit(owner: IoSnapshotRequest['owner'], device: DeviceId, command?: IoSnapshotRequest['command'], mode?: IoMode): number {
    check(this.host.enabled(), 'I/O disabled'); const state = this.deviceState(device);
    const selected = command ?? this.defaultCommand(state); this.validateCommand(selected);
    const id = this.data.nextRequestId++;
    const next = continuation(mode ?? state.mode, bytesFor({ command: selected }), state.wordSize, this.host.settings().dmaCycleStealRatio);
    const req: Request = { id, owner: structuredClone(owner) as Mutable<IoSnapshotRequest['owner']>, device, submittedAtTick: this.host.tick(), startedAtTick: null, wordSize: state.wordSize,
      command: structuredClone(selected) as Mutable<IoSnapshotRequest['command']>, service: { kind: 'queued' }, continuation: structuredClone(next), instructionRetired: owner.kind !== 'actor', wakeable: false };
    this.data.requests.push(req);
    this.host.onRequestSubmitted?.(req);
    if (owner.kind === 'actor') this.host.emit({ type: 'io.request', pid: owner.actor.pid, device, mode: next.mode });
    else { req.continuation.setupTicksRemaining = 0; this.drivers.get(device)!.submit(req, this.context); }
    this.refreshDevices(); return id;
  }
  request(pid: Pid, device: DeviceId): void {
    if (!this.host.enabled()) return;
    const actor = this.host.actor(pid); check(actor !== undefined, 'I/O actor');
    let req = this.actorRequest(actor, false);
    if (req === undefined) req = this.requireRequest(this.submit({ kind: 'actor', actor }, device));
    check(req.device === device, 'I/O continuation device');
    if (req.continuation.mode === 'polling' && req.wakeable) { req.instructionRetired = true; this.removeRequest(req.id); return; }
    if (req.continuation.setupTicksRemaining > 0) {
      req.continuation.setupTicksRemaining -= 1; this.data.cpuCharges.issueTicks += 1;
      if (req.continuation.setupTicksRemaining === 0) this.drivers.get(device)!.submit(req, this.context);
    }
    if (req.continuation.setupTicksRemaining === 0 && req.continuation.mode !== 'polling') {
      req.instructionRetired = true; this.host.block(actor, device);
    }
    this.refreshDevices();
  }
  instructionOutcome(actor: IoSnapshotActor): { advance: boolean; deferService: boolean } {
    const pending = this.actorRequest(actor, false); return { advance: pending === undefined, deferService: pending !== undefined };
  }
  gate(actor: IoSnapshotActor): boolean {
    if (!this.host.enabled()) return false;
    const req = this.actorRequest(actor, false);
    if (req?.continuation.mode === 'polling' && req.continuation.setupTicksRemaining === 0) {
      const pending = req.continuation;
      if (req.service.kind !== 'completed') {
        pending.wastedPolls += 1;
        let row = this.data.pollTicks.find(value => value.pid === actor.pid);
        if (row === undefined) { row = { pid: actor.pid, ticks: 0 }; this.data.pollTicks.push(row); }
        row.ticks += 1; return true;
      }
      if (!pending.wastedEventEmitted) { pending.wastedEventEmitted = true; this.host.emit({ type: 'io.poll_wasted', device: req.device, wastedTicks: pending.wastedPolls }); }
      pending.copiedWords += 1;
      if (pending.copiedWords >= transferTicks(bytesFor(req), req.wordSize)) { req.wakeable = true; return false; }
      return true;
    }
    const transfer = this.data.requests.find(value => value.continuation.mode === 'dma' && value.service.kind === 'completed'
      && !value.continuation.dmaEventEmitted && value.continuation.elapsedTransferTicks < value.continuation.transferTicks
      && value.continuation.stealsCharged < value.continuation.stealAccumulator
      && (value.owner.kind !== 'actor' || !sameActor(value.owner.actor, actor)));
    if (transfer?.continuation.mode === 'dma') {
      transfer.continuation.stealsCharged += 1; this.data.cpuCharges.dmaStealTicks += 1; return true;
    }
    return false;
  }
  isSatisfied(pid: Pid, tid: Tid, reason: BlockReason): boolean {
    if (!this.host.enabled() || reason.kind !== 'io') return false;
    const actor = { pid, tid };
    if (this.cache.isSatisfied(actor)) { this.refreshDevices(); return true; }
    const req = this.data.requests.find(value => value.owner.kind === 'actor' && sameActor(value.owner.actor, actor) && value.device === reason.device && value.wakeable);
    if (req === undefined) return false;
    this.removeRequest(req.id); return true;
  }
  expireTimers(tick: Tick): void {
    if (!this.host.enabled() || this.data.lastTimerTick === tick) return;
    this.data.lastTimerTick = tick;
    for (const req of this.data.requests) {
      if (req.service.kind === 'timer' && req.service.remainingTicks > 0) req.service.remainingTicks -= 1;
      const dma = req.continuation;
      if (dma.mode === 'dma' && req.service.kind === 'completed' && !dma.dmaEventEmitted && dma.elapsedTransferTicks < dma.transferTicks) {
        dma.elapsedTransferTicks += 1;
        dma.stealAccumulator = Math.min(dma.stealBudget, Math.floor((dma.elapsedTransferTicks + 1) * dma.stealBudget / Math.max(1, dma.transferTicks)));
      }
    }
    for (const device of this.data.devices) if (device.mitigation !== null) {
      const pending = this.interrupts.lines.find(line => line.device === device.id)?.pending ?? 0;
      device.mitigation.healthyTicks = pending === 0 && device.pollingTokens.length === 0 ? device.mitigation.healthyTicks + 1 : 0;
      if (device.mitigation.healthyTicks >= this.host.settings().interruptStormWindow) {
        device.mode = device.mitigation.priorMode;
        if (!device.mitigation.wasMasked) this.interrupts.mask.delete(device.id);
        device.mitigation = null;
      }
    }
  }
  serviceCompletions(tick: Tick): void {
    if (!this.host.enabled() || this.data.lastCompletionTick === tick) return;
    this.data.lastCompletionTick = tick;
    for (const req of [...this.data.requests]) {
      if (req.service.kind === 'queued' && req.continuation.setupTicksRemaining === 0 && req.command.kind === 'write' && this.target(this.deviceState(req.device)) !== null) {
        if (req.startedAtTick === null) this.start(req);
        else if (!this.cache.pendingWrite(req.device, req.command.lba)) this.mediaDone(req, this.cache.isDurable(req.device, req.command.lba)
          ? { kind: 'ok', data: [] } : { kind: 'failed', reason: 'device_failed' });
      }
      if (req.service.kind === 'timer' && req.service.remainingTicks === 0) this.mediaDone(req, { kind: 'ok', data: req.command.kind === 'read' ? Array.from({ length: req.command.bytes }, () => 0) : [] });
      else if (req.service.kind === 'storage') {
        const completed = this.storage?.takeCompletion(req.service.storageRequestId);
        if (completed !== null && completed !== undefined) this.mediaDone(req, completed.result);
      }
      const dma = req.continuation;
      if (dma.mode === 'dma' && req.service.kind === 'completed' && !dma.dmaEventEmitted && dma.elapsedTransferTicks >= dma.transferTicks) {
        dma.dmaEventEmitted = true; this.host.emit({ type: 'io.dma_transfer', device: req.device, bytes: bytesFor(req) });
        this.raiseCompletion(req); this.releaseDevice(req);
      }
    }
    for (const device of this.data.devices) if (device.mitigation === null) {
      while (device.pollingTokens.length > 0 && this.interrupts.retry(device.id, device.pollingTokens[0]!)) device.pollingTokens.shift();
    }
    for (const device of this.data.devices) if (device.mitigation !== null && tick >= device.mitigation.nextPollAtTick) {
      device.pollingTokens.push(...this.interrupts.takePending(device.id));
      device.pollingTokens.sort((a, b) => a.id - b.id);
      if (device.pollingTokens.length > 0) this.charge('interrupt', device.id, null, 1);
      for (const token of device.pollingTokens.splice(0)) this.handleToken(device.id, token);
      device.mitigation.nextPollAtTick = (tick + this.host.settings().interruptStormWindow) as Tick;
    }
    for (const buffer of this.buffers.values()) buffer.step(tick);
    this.spool.step(); this.cache.pump(); this.refreshDevices();
  }
  deliverInterrupts(tick: Tick): void {
    if (!this.host.enabled()) return;
    this.inDelivery = true;
    try {
      for (const charge of this.data.pendingKernelCharges.splice(0)) this.charge(charge.kind, charge.device, charge.requestId, charge.ticks);
      this.interrupts.deliver(tick);
    } finally { this.inDelivery = false; }
    this.refreshDevices();
  }
  control(device: DeviceId, command: string, args: readonly (string | number | boolean)[], actor: IoSnapshotActor | undefined): SyscallResult {
    if (!this.host.enabled()) return failure('I/O disabled');
    for (const extension of this.controlExtensions) {
      const result = extension(device, command, args, actor);
      if (result !== undefined) { this.refreshDevices(); return result; }
    }
    const driver = this.drivers.get(device); if (driver === undefined) return failure('unknown device');
    this.controlActor = actor;
    try { const result = driver.control(command, args, this.context); this.refreshDevices(); return result; }
    finally { this.controlActor = undefined; }
  }
  sync(actor: IoSnapshotActor | undefined): SyscallResult {
    if (!this.host.enabled() || actor === undefined) return failure('missing I/O caller');
    const result = this.cache.sync(actor); this.refreshDevices(); return result;
  }
  registerControl(extension: IoControlExtension): () => void {
    this.controlExtensions.add(extension); return () => { this.controlExtensions.delete(extension); };
  }
  /** Crash is unconditional; reset's DMA refusal remains unchanged. */
  crashAbort(): { readonly requests: readonly number[]; readonly dirty: readonly { readonly device: DeviceId; readonly sectorLba: BlockId }[] } {
    const ids = new Set(this.data.requests.map(request => request.id));
    const dirty = this.cache.snapshot().entries.filter(entry => entry.generation > entry.durableGeneration)
      .map(entry => ({ device: entry.device, sectorLba: entry.block }));
    for (const device of this.data.devices) {
      device.activeRequestId = null; device.requestOrder.length = 0; device.pollingTokens.length = 0;
      if (device.mitigation !== null) { device.mode = device.mitigation.priorMode; device.mitigation = null; }
      this.spool.reset(device.id);
    }
    for (const buffer of this.buffers.values()) buffer.remove(ids);
    this.cache.dropDirty();
    for (const device of this.data.devices) this.cache.abortDevice(device.id);
    this.host.abortStorage?.();
    for (const request of [...this.data.requests]) {
      if (request.service.kind === 'storage') this.storage?.cancel(request.service.storageRequestId);
      if (request.owner.kind !== 'actor') { this.removeRequest(request.id); continue; }
      request.service = { kind: 'completed', atTick: this.host.tick(), result: { kind: 'failed', reason: 'cancelled' } };
      request.wakeable = true; request.continuation.setupTicksRemaining = 0;
      if (request.continuation.mode === 'dma') {
        request.continuation.dmaEventEmitted = true;
        request.continuation.elapsedTransferTicks = request.continuation.transferTicks;
        request.continuation.stealAccumulator = request.continuation.stealBudget;
        request.continuation.stealsCharged = request.continuation.stealBudget;
      } else if (request.continuation.mode === 'interrupt') request.continuation.copyDebt = 'charged';
      this.host.onRequestRemoved?.(request);
    }
    const interrupts = this.interrupts.snapshot();
    this.interrupts.restore({ ...interrupts, lines: interrupts.lines.map(line => ({ ...line, pending: [], panicEmitted: false })),
      serviceStack: [], masks: [], storm: null });
    this.data.pendingKernelCharges.length = 0;
    this.host.chargeKernelDebt(-this.data.kernelDebt); this.data.kernelDebt = 0;
    this.refreshDevices();
    return { requests: [...ids], dirty };
  }
  dirtyEntries(): readonly import('../types').BlockId[] { return this.cache.dirtyEntries(); }
  dropDirty(): readonly import('../types').BlockId[] { return this.cache.dropDirty(); }
  takeResult(id: number): IoSnapshotResult | null {
    const req = this.find(id); if (req?.wakeable !== true || req.service.kind !== 'completed') return null;
    const result = structuredClone(req.service.result); this.removeRequest(id); return result;
  }
  removeWaiter(pid: Pid): void {
    const ids = new Set(this.data.requests.filter(req => req.owner.kind === 'actor' && req.owner.actor.pid === pid).map(req => req.id));
    for (const device of this.data.devices) device.requestOrder = device.requestOrder.filter(id => !ids.has(id));
    for (const id of ids) this.cancelRequest(id);
    for (const buffer of this.buffers.values()) buffer.remove(ids);
    this.spool.removeWaiter(pid); this.cache.removeWaiter(pid, ids);
    this.interrupts.remove(token => token.kind === 'signal' && token.sourcePid === pid); this.refreshDevices();
  }
  saveState(): { io: IoSnapshotState } {
    const payload: Payload = { ...this.data, tick: this.host.tick(), settings: { ...this.host.settings() },
      requests: [...this.data.requests].sort((a, b) => a.id - b.id), devices: [...this.data.devices].sort((a, b) => compareText(a.id, b.id)),
      pollTicks: [...this.data.pollTicks].sort((a, b) => a.pid - b.pid), interrupts: this.interrupts.snapshot(), cache: this.cache.snapshot(),
      buffers: [...this.buffers].sort(([a], [b]) => compareText(a, b)).map(([, buffer]) => buffer.snapshot()), spools: this.spool.snapshot() };
    return { io: { owner: 'io', version: 1, payload: structuredClone(payload) } };
  }
  prepareRestore(saved: IoSnapshotState): () => void {
    check(saved.owner === 'io' && saved.version === 1, 'snapshot version'); plainData(saved);
    const copy = structuredClone(saved); this.validate(copy.payload);
    return () => {
      this.data = structuredClone(copy.payload) as Mutable<Payload>; this.interrupts.restore(copy.payload.interrupts); this.cache.restore(copy.payload.cache);
      this.spool.restore(copy.payload.spools); this.buffers.clear();
      for (const buffer of copy.payload.buffers) this.configureBuffer(buffer.device, buffer.scheme, buffer.producerTicks, buffer.consumerTicks).restore(buffer);
      this.drivers.clear(); for (const device of this.data.devices) this.bindDriver(device); this.refreshDevices();
    };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    const saved = snapshot.subsystems?.io;
    if (saved === undefined) {
      check(snapshot.subsystems === undefined, 'missing I/O contribution');
      const pristine = new IoSubsystem({ ...this.host, tick: () => snapshot.tick }, this.rng, this.storage).saveState().io;
      const active = snapshot.tick > 0 && snapshot.config.enabledSubsystems.includes('io');
      const phaseTick = active ? snapshot.tick : null;
      const legacy: IoSnapshotState = { ...pristine, payload: { ...pristine.payload,
        lastTimerTick: phaseTick, lastCompletionTick: phaseTick,
        interrupts: { ...pristine.payload.interrupts, budgetTick: phaseTick, lastStormSampleTick: phaseTick },
      } };
      const devices = this.projectDevices(legacy.payload.devices, [], () => undefined);
      check(snapshot.devices.length === 0 || JSON.stringify(snapshot.devices) === JSON.stringify(devices), 'legacy device work cannot be recovered');
      return this.prepareRestore(legacy);
    }
    check(saved.payload.tick === snapshot.tick, 'I/O shared clock');
    const commit = this.prepareRestore(saved);
    const storage = snapshot.subsystems?.storage?.payload;
    const storageRows = storage?.requests ?? [];
    const requests = saved.payload.requests;
    const flushes = saved.payload.cache.flushes;
    for (const req of requests) if (req.service.kind === 'storage') {
      const id = req.service.storageRequestId;
      const row = storageRows.find(candidate => candidate.id === id);
      check(row !== undefined && row.cancelledAtTick === null && row.consumer.kind === 'io' && row.consumer.requestId === req.id, 'storage request ownership');
      check(req.command.kind === 'read' && row.transfer.kind === 'read' && row.transfer.lba === req.command.lba && row.transfer.bytes === req.command.bytes, 'storage request command');
    }
    for (const flush of flushes) if (flush.progress.kind === 'storage') {
      const id = flush.progress.storageRequestId; const row = storageRows.find(candidate => candidate.id === id);
      check(row !== undefined && row.cancelledAtTick === null && row.consumer.kind === 'cache' && row.consumer.flushId === flush.id, 'cache storage ownership');
      check(row.transfer.kind === 'write' && row.transfer.lba === flush.block && JSON.stringify(row.transfer.data) === JSON.stringify(flush.contents), 'cache storage command');
    }
    for (const row of storageRows) {
      if (row.cancelledAtTick !== null) continue;
      if (row.consumer.kind === 'io') { const id = row.consumer.requestId; const req = requests.find(candidate => candidate.id === id);
        check(req?.service.kind === 'storage' && req.service.storageRequestId === row.id, 'reverse I/O ownership'); }
      if (row.consumer.kind === 'cache') { const id = row.consumer.flushId; const flush = flushes.find(candidate => candidate.id === id);
        check(flush?.progress.kind === 'storage' && flush.progress.storageRequestId === row.id, 'reverse cache ownership'); }
    }
    for (const device of saved.payload.devices) {
      const target = this.target(device);
      if (target?.kind === 'disk') check(storage?.drives.some(drive => drive.driveId === target.driveId), 'disk backing');
      if (target?.kind === 'nvm') check(storage?.nvm.some(nvm => nvm.deviceId === target.deviceId), 'NVM backing');
      if (target?.kind === 'raid') check(storage?.raid.some(raid => raid.arrayId === target.arrayId), 'RAID backing');
    }
    const projected = this.projectDevices(saved.payload.devices, saved.payload.requests, pid => snapshot.processes.find(pcb => pcb.pid === pid));
    check(JSON.stringify(projected) === JSON.stringify(snapshot.devices), 'shared device projection'); return commit;
  }
  assertInvariants(): void {
    if (!this.host.enabled()) return; this.refreshDevices();
    for (const device of this.devices) for (const pid of device.queue) {
      const pcb = this.host.process(pid); check(pcb?.state === 'waiting' && pcb.blockedOn?.kind === 'io' && pcb.blockedOn.device === device.id, 'I-32 device waiter');
    }
    for (const line of this.interrupts.lines) check(line.pending >= 0 && line.pending <= this.host.settings().maxPendingInterrupts, 'I-33 pending');
  }
  private validate(payload: Payload): void {
    check(validInteger(payload.tick) && validInteger(payload.kernelDebt), 'I/O clock/debt');
    for (const key of Object.keys(this.host.settings()) as (keyof IoSettings)[]) check(payload.settings[key] === this.host.settings()[key], 'I/O settings mismatch');
    for (const value of [payload.nextRequestId, payload.nextInterruptTokenId, payload.nextFlushId, payload.nextSyncId, payload.nextSpoolJobId]) check(validInteger(value, 1), 'I/O allocator');
    for (const clock of [payload.lastTimerTick, payload.lastCompletionTick]) check(clock === null || validInteger(clock) && clock <= payload.tick, 'I/O phase clock');
    const ids = new Set<number>(); const devices = new Set<DeviceId>();
    for (const device of payload.devices) {
      check(typeof device.id === 'string' && !devices.has(device.id) && validInteger(device.latency, 1) && validInteger(device.wordSize, 1)
        && modeValid(device.mode) && modeValid(device.defaultMode), 'device identity'); devices.add(device.id);
      check(['disk0', 'nvm0', 'character_output', 'net0', 'timer_fixture', 'printer_fixture'].includes(device.driver.kind), 'driver kind');
      if (device.driver.kind === 'net0') check(device.driver.lossProbability >= 0 && device.driver.lossProbability <= 1, 'packet loss');
    }
    for (const req of payload.requests) {
      check(validInteger(req.id, 1) && req.id < payload.nextRequestId && !ids.has(req.id) && devices.has(req.device), 'request identity'); ids.add(req.id);
      this.validateCommand(req.command); check(validInteger(req.wordSize, 1) && validInteger(req.submittedAtTick) && req.submittedAtTick <= payload.tick, 'request clock');
      check(modeValid(req.continuation.mode) && validInteger(req.continuation.setupTicksRemaining) && req.continuation.setupTicksRemaining <= (req.continuation.mode === 'dma' ? 2 : 1), 'setup continuation');
      if (req.continuation.mode === 'polling') check(validInteger(req.continuation.copiedWords) && req.continuation.copiedWords <= transferTicks(bytesFor(req), req.wordSize) && validInteger(req.continuation.wastedPolls), 'poll continuation');
      if (req.continuation.mode === 'dma') {
        const dma = req.continuation; check(validInteger(dma.transferTicks) && validInteger(dma.elapsedTransferTicks) && dma.elapsedTransferTicks <= dma.transferTicks
          && validInteger(dma.stealBudget) && validInteger(dma.stealsCharged) && dma.stealsCharged <= dma.stealBudget && validInteger(dma.stealAccumulator) && dma.stealAccumulator <= dma.stealBudget, 'DMA continuation');
      }
      check(typeof req.instructionRetired === 'boolean' && typeof req.wakeable === 'boolean', 'request flags');
      check(req.startedAtTick === null || validInteger(req.startedAtTick) && req.startedAtTick >= req.submittedAtTick && req.startedAtTick <= payload.tick, 'request start');
      check(['queued', 'timer', 'storage', 'completed'].includes(req.service.kind), 'request service');
      if (req.owner.kind === 'actor') check(validInteger(req.owner.actor.pid, 2) && validInteger(req.owner.actor.tid, 1), 'request actor');
      else check(['cache', 'spool', 'kernel'].includes(req.owner.kind), 'request owner');
      if (req.service.kind === 'completed') { check(validInteger(req.service.atTick) && req.service.atTick <= payload.tick, 'completion clock'); this.validateResult(req.service.result); }
      if (req.service.kind === 'timer') check(validInteger(req.service.remainingTicks), 'device counter');
      if (req.service.kind === 'storage') check(validInteger(req.service.storageRequestId), 'storage reference');
    }
    const flushes = payload.cache.flushes;
    for (const req of payload.requests) {
      if (req.owner.kind === 'cache') { const id = req.owner.flushId; const flush = flushes.find(row => row.id === id);
        check(flush?.progress.kind === 'io' && flush.progress.requestId === req.id && flush.device === req.device, 'I/O cache ownership'); }
      if (req.owner.kind === 'spool') { const id = req.owner.jobId;
        check(payload.spools.some(spool => spool.device === req.device && spool.jobs.some(job => job.id === id && job.requestId === req.id)), 'I/O spool ownership'); }
    }
    for (const flush of flushes) {
      check(devices.has(flush.device) && flush.id < payload.nextFlushId, 'flush device/allocator');
      if (flush.progress.kind === 'io') { const id = flush.progress.requestId; const req = payload.requests.find(row => row.id === id);
        check(req?.owner.kind === 'cache' && req.owner.flushId === flush.id, 'reverse cache I/O ownership'); }
      if (flush.progress.kind === 'storage') check(validInteger(flush.progress.storageRequestId), 'flush storage ID');
      if (flush.progress.kind === 'completed') this.validateResult(flush.progress.result);
    }
    for (const admission of payload.cache.admissions) check(ids.has(admission.requestId) && devices.has(admission.device), 'cache admission ownership');
    for (const entry of payload.cache.entries) check(devices.has(entry.device), 'cache device');
    check(new Set(payload.buffers.map(buffer => buffer.device)).size === payload.buffers.length, 'duplicate buffer');
    for (const buffer of payload.buffers) {
      check(devices.has(buffer.device), 'buffer device');
      const owned = [...buffer.producerWaiters, ...buffer.consumerWaiters, ...buffer.ready.map(row => row.requestId),
        ...(buffer.filling === null ? [] : [buffer.filling.requestId]), ...(buffer.draining === null ? [] : [buffer.draining.requestId])];
      check(new Set(owned).size === owned.length && owned.every(id => payload.requests.some(req => req.id === id && req.device === buffer.device)), 'buffer request ownership');
    }
    for (const spool of payload.spools) {
      check(devices.has(spool.device), 'spool device');
      for (const job of spool.jobs) check(job.id < payload.nextSpoolJobId && (job.requestId === null || ids.has(job.requestId)), 'spool request/allocator');
    }
    for (const row of payload.pollTicks) check(validInteger(row.pid, 2) && validInteger(row.ticks), 'poll counters');
    for (const value of Object.values(payload.cpuCharges)) check(validInteger(value), 'CPU charge counter');
    const tokenIds = new Set<number>();
    for (const token of [...payload.interrupts.lines.flatMap(line => line.pending), ...payload.devices.flatMap(device => device.pollingTokens)]) {
      check(validInteger(token.id, 1) && validInteger(token.raisedAtTick) && token.raisedAtTick <= payload.tick && token.id < payload.nextInterruptTokenId && !tokenIds.has(token.id), 'token allocator/reference'); tokenIds.add(token.id);
      if (token.kind === 'completion') check(ids.has(token.requestId), 'orphan completion');
    }
    for (const device of payload.devices) {
      const belongs = (id: number): boolean => payload.requests.some(req => req.id === id && req.device === device.id);
      check(new Set(device.requestOrder).size === device.requestOrder.length && device.requestOrder.every(belongs)
        && (device.activeRequestId === null || belongs(device.activeRequestId) && !device.requestOrder.includes(device.activeRequestId)), 'device request references');
      if (device.mitigation !== null) check(modeValid(device.mitigation.priorMode) && typeof device.mitigation.wasMasked === 'boolean'
        && validInteger(device.mitigation.healthyTicks) && validInteger(device.mitigation.nextPollAtTick) && device.mode === 'polling', 'storm mitigation');
    }
    for (const line of payload.interrupts.lines) for (const token of line.pending) if (token.kind === 'completion') check(payload.requests.some(req => req.id === token.requestId && req.device === line.device), 'interrupt device ownership');
    for (const charge of payload.pendingKernelCharges) check(validInteger(charge.ticks, 1) && devices.has(charge.device) && (charge.requestId === null || validInteger(charge.requestId, 1) && charge.requestId < payload.nextRequestId), 'pending kernel charge');
    this.interrupts.validate(payload.interrupts); this.cache.validate(payload.cache);
    const spool = new Spooler({ tick: () => payload.tick, nextJob: () => 0, emit: () => {}, output: () => {}, complete: () => {} }); spool.restore(payload.spools);
    for (const buffer of payload.buffers) new DeviceBuffer(buffer.device, buffer.scheme, { contents: () => [], consumed: () => {} }, buffer.producerTicks, buffer.consumerTicks).validate(buffer);
  }
  private addDevice(id: DeviceId, displayName: string, latency: number, mode: IoMode, wordSize: number, driver: IoSnapshotDevice['driver'], priority: number): void {
    check(!this.data.devices.some(device => device.id === id) && validInteger(latency, 1) && validInteger(wordSize, 1), 'device configuration');
    const device: Mutable<IoSnapshotDevice> = { id, displayName, defaultMode: mode, mode, latency, wordSize, requestOrder: [], activeRequestId: null, pollingTokens: [], mitigation: null, driver: structuredClone(driver) as Mutable<IoSnapshotDevice['driver']> };
    this.data.devices.push(device); this.data.devices.sort((a, b) => compareText(a.id, b.id)); this.bindDriver(device); this.interrupts.register(id, priority); this.refreshDevices();
  }
  private bindDriver(device: IoSnapshotDevice): void {
    const snapshot = (): IoSnapshotDevice => structuredClone(this.deviceState(device.id));
    const driver = device.driver.kind === 'nvm0' ? nvm0Driver(device.id, snapshot)
      : device.driver.kind === 'character_output' || device.driver.kind === 'printer_fixture' ? characterOutputDriver(device.id, snapshot)
      : device.driver.kind === 'net0' ? net0Driver(device.id, snapshot) : disk0Driver(device.id, snapshot);
    this.drivers.set(device.id, driver);
  }
  private defaultCommand(device: IoSnapshotDevice): IoSnapshotRequest['command'] {
    if (device.driver.kind === 'character_output' || device.driver.kind === 'printer_fixture') return { kind: 'character', contents: [0] };
    if (device.driver.kind === 'net0') return { kind: 'packet', contents: Array.from({ length: 64 }, () => 0) };
    return { kind: 'read', lba: asBlockId(0), bytes: 4096 };
  }
  private start(req: Request): { acceptedTicks: number; blocks: boolean; queuePosition: number } {
    const device = this.deviceState(req.device); const target = this.target(device);
    const result = { acceptedTicks: req.continuation.mode === 'dma' ? 2 : 1, blocks: req.continuation.mode !== 'polling', queuePosition: device.requestOrder.length };
    if (req.startedAtTick !== null) return result;
    if (device.driver.kind === 'disk0' || device.driver.kind === 'nvm0') {
      if (target === null || this.storage === undefined) { this.mediaDone(req, { kind: 'failed', reason: 'device_failed' }); return result; }
      check(req.command.kind === 'read' || req.command.kind === 'write', 'block command');
      if (req.command.kind === 'write') {
        if (!this.cache.write(device.id, req.command.lba, req.command.contents, req.id)) return result;
        req.startedAtTick = this.host.tick();
        if (this.cache.policy === 'write_back') this.mediaDone(req, { kind: 'ok', data: [] });
        return result;
      }
      req.startedAtTick = this.host.tick();
      if (req.command.kind === 'read') {
        const cached = this.cache.read(device.id, req.command.lba);
        if (cached !== null && cached.length === req.command.bytes) { this.mediaDone(req, { kind: 'ok', data: cached }); return result; }
      }
      const transfer: StorageTransferSnapshot = req.command;
      req.service = { kind: 'storage', storageRequestId: this.storage.submit(target, transfer, { kind: 'io', requestId: req.id }, req.owner.kind === 'actor' ? req.owner.actor.pid : null) };
      return result;
    }
    const buffer = this.buffers.get(device.id);
    if (buffer !== undefined) { req.startedAtTick = this.host.tick(); buffer.enqueue(req.id); return result; }
    if (device.activeRequestId !== null) { if (!device.requestOrder.includes(req.id)) device.requestOrder.push(req.id); return result; }
    device.activeRequestId = req.id; req.startedAtTick = this.host.tick();
    req.service = { kind: 'timer', remainingTicks: device.driver.kind === 'character_output' ? Math.max(1, bytesFor(req)) : device.latency };
    return result;
  }
  private mediaDone(req: Request, result: IoSnapshotResult): void {
    this.host.onRequestCompleted?.(req, result);
    req.service = { kind: 'completed', atTick: this.host.tick(), result: structuredClone(result) as Mutable<IoSnapshotResult> };
    const driver = this.drivers.get(req.device); check(driver !== undefined, 'completion driver'); driver.complete(req, this.context);
  }
  private finishMedia(req: Request, result: IoSnapshotResult): void {
    req.service = { kind: 'completed', atTick: this.host.tick(), result: structuredClone(result) as Mutable<IoSnapshotResult> };
    if (result.kind === 'ok' && req.command.kind === 'read' && this.target(this.deviceState(req.device)) !== null) this.cache.fill(req.device, req.command.lba, result.data);
    if (req.continuation.mode === 'interrupt') { this.raiseCompletion(req); this.releaseDevice(req); }
    else if (req.continuation.mode === 'polling') this.releaseDevice(req);
  }
  private raiseCompletion(req: Request): void {
    const device = this.deviceState(req.device);
    if (device.mitigation !== null || !this.interrupts.raise(req.device, { kind: 'completion', requestId: req.id }))
      device.pollingTokens.push({ kind: 'completion', requestId: req.id, id: this.data.nextInterruptTokenId++, raisedAtTick: this.host.tick() });
  }
  private handleToken(device: DeviceId, token: IoSnapshotInterruptToken): void {
    if (token.kind === 'panic') { this.host.emit({ type: 'kernel.panic', message: token.message }); return; }
    if (token.kind !== 'completion') return;
    const req = this.find(token.requestId); if (req === undefined) return;
    if (req.continuation.mode === 'interrupt' && req.continuation.copyDebt === 'not_due') {
      req.continuation.copyDebt = this.inDelivery ? 'charged' : 'pending'; this.charge('copy', device, req.id, transferTicks(bytesFor(req), req.wordSize));
    }
    req.wakeable = true; this.drivers.get(device)?.onInterrupt(this.context);
  }
  private charge(kind: 'interrupt' | 'copy', device: DeviceId, requestId: number | null, ticks: number): void {
    if (ticks === 0) return;
    if (!this.inDelivery) { this.data.pendingKernelCharges.push({ kind, device, requestId, ticks }); return; }
    this.data.kernelDebt += ticks; this.data.cpuCharges[kind === 'copy' ? 'copyTicks' : 'interruptTicks'] += ticks; this.host.chargeKernelDebt(ticks);
    if (kind === 'copy' && requestId !== null) { const req = this.find(requestId); if (req?.continuation.mode === 'interrupt') req.continuation.copyDebt = 'charged'; }
  }
  private mitigate(deviceId: DeviceId): void {
    const device = this.deviceState(deviceId); if (device.mitigation !== null) return;
    device.mitigation = { priorMode: device.mode, wasMasked: this.interrupts.mask.has(deviceId), healthyTicks: 0,
      nextPollAtTick: (this.host.tick() + this.host.settings().interruptStormWindow) as Tick };
    device.mode = 'polling'; device.pollingTokens.push(...this.interrupts.takePending(deviceId)); device.pollingTokens.sort((a, b) => a.id - b.id);
  }
  private tokenPid(token: IoSnapshotInterruptToken): Pid | null {
    if (token.kind === 'signal') return token.sourcePid;
    if (token.kind !== 'completion') return null;
    const req = this.find(token.requestId); return req?.owner.kind === 'actor' ? req.owner.actor.pid : null;
  }
  private releaseDevice(req: Request): void {
    const device = this.deviceState(req.device);
    if (device.activeRequestId === req.id) {
      device.activeRequestId = null;
      const id = device.requestOrder.shift(); if (id !== undefined) { const next = this.find(id); if (next !== undefined) this.start(next); }
    }
  }
  private cancelRequest(id: number): void { const req = this.find(id); if (req?.service.kind === 'storage') this.storage?.cancel(req.service.storageRequestId); this.removeRequest(id); }
  private removeRequest(id: number): void {
    const req = this.find(id); if (req !== undefined) this.releaseDevice(req);
    if (req !== undefined) this.host.onRequestRemoved?.(req);
    this.data.requests = this.data.requests.filter(value => value.id !== id);
    this.interrupts.remove(token => token.kind === 'completion' && token.requestId === id);
    for (const device of this.data.devices) { device.requestOrder = device.requestOrder.filter(value => value !== id); device.pollingTokens = device.pollingTokens.filter(token => token.kind !== 'completion' || token.requestId !== id); }
    this.refreshDevices();
  }
  private actorRequest(actor: IoSnapshotActor, retired: boolean): Request | undefined {
    return this.data.requests.find(req => req.owner.kind === 'actor' && sameActor(req.owner.actor, actor) && req.instructionRetired === retired);
  }
  private find(id: number): Request | undefined { return this.data.requests.find(req => req.id === id); }
  private requireRequest(id: number): Request { const req = this.find(id); check(req !== undefined, 'missing request'); return req; }
  private deviceState(device: DeviceId): Mutable<IoSnapshotDevice> { const state = this.data.devices.find(row => row.id === device); check(state !== undefined, 'unknown device'); return state; }
  private target(device: IoSnapshotDevice): IoStorageTarget | null {
    if (device.driver.kind === 'disk0') return device.driver.backing;
    if (device.driver.kind === 'nvm0' && device.driver.backing !== null) return { kind: 'nvm', deviceId: device.driver.backing.deviceId };
    return null;
  }
  private output(device: DeviceId, bytes: readonly number[]): void {
    const state = this.deviceState(device); if (state.driver.kind === 'character_output' || state.driver.kind === 'printer_fixture') state.driver.output.push(...bytes);
  }
  private driverControl(deviceId: DeviceId, command: string, args: readonly (string | number | boolean)[]): SyscallResult {
    const device = this.deviceState(deviceId);
    const target = this.target(device);
    const route = command === 'set_policy' ? deviceId : target?.kind === 'raid' ? target.arrayId as DeviceId : target?.kind === 'disk' ? target.driveId as DeviceId : target?.kind === 'nvm' ? target.deviceId : deviceId;
    if (command === 'set_mode') {
      if (args.length !== 1 || !modeValid(args[0])) return failure('invalid I/O mode'); device.mode = args[0]; return success();
    }
    if (command === 'reset') {
      if (this.data.requests.some(req => req.device === deviceId && req.continuation.mode === 'dma' && !req.wakeable)) return { ok: false, errno: 'EBUSY', message: 'DMA in flight' };
      if (target !== null) {
        const result = this.storage?.control?.(route, 'reset', args, this.controlActor?.pid);
        if (result !== undefined && !result.ok) return result;
      }
      const ids = new Set(this.data.requests.filter(req => req.device === deviceId).map(req => req.id));
      this.buffers.get(deviceId)?.remove(ids); this.spool.reset(deviceId); this.cache.abortDevice(deviceId);
      for (const req of [...this.data.requests]) if (req.device === deviceId) { if (req.service.kind === 'storage') this.storage?.cancel(req.service.storageRequestId); req.service = { kind: 'completed', atTick: this.host.tick(), result: { kind: 'failed', reason: 'cancelled' } }; req.wakeable = true; }
      device.activeRequestId = null; device.requestOrder.length = 0; device.pollingTokens.length = 0; this.interrupts.clear(deviceId); return success();
    }
    if (command === 'set_loss' && device.driver.kind === 'net0') {
      const ratio = args[0]; if (args.length !== 1 || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) return failure('invalid loss ratio');
      device.driver.lossProbability = ratio; return success();
    }
    if (command === 'flush' && device.driver.kind === 'character_output') {
      const drained = device.driver.output.length; device.driver.output.length = 0; return success(drained);
    }
    const allowed = device.driver.kind === 'disk0' ? ['set_policy', 'crash', 'fail_disk'] : device.driver.kind === 'nvm0' ? ['trim', 'flush'] : [];
    if (!allowed.includes(command)) return failure('unknown device command');
    if (command === 'crash') this.cache.dropDirty();
    return this.storage?.control?.(route, command, args, this.controlActor?.pid) ?? failure('storage control unavailable');
  }
  private submitFlush(flush: CacheFlush): { kind: 'storage'; storageRequestId: number } | { kind: 'io'; requestId: number } | null {
    if (!this.host.enabled()) return null;
    const device = this.deviceState(flush.device); const target = this.target(device);
    if (target !== null && this.storage !== undefined) return { kind: 'storage', storageRequestId: this.storage.submit(target,
      { kind: 'write', lba: flush.block, data: flush.contents }, { kind: 'cache', flushId: flush.id }, null) };
    if (device.driver.kind === 'timer_fixture') return { kind: 'io', requestId: this.submit({ kind: 'cache', flushId: flush.id }, device.id,
      { kind: 'write', lba: flush.block, contents: flush.contents }, 'interrupt') };
    return null;
  }
  private validateResult(result: IoSnapshotResult): void {
    check(['ok', 'failed', 'lost'].includes(result.kind), 'result kind');
    if (result.kind === 'ok') check(result.data.every(byte => validInteger(byte) && byte <= 255), 'result bytes');
    if (result.kind === 'failed') check(['io_timeout', 'storage_corruption', 'cancelled', 'device_failed'].includes(result.reason), 'failure reason');
  }
  private validateCommand(command: IoSnapshotRequest['command']): void {
    check(['read', 'write', 'character', 'packet'].includes(command.kind), 'I/O command');
    if (command.kind === 'read') check(validInteger(command.lba) && validInteger(command.bytes, 1), 'read extent');
    else check(command.contents.length > 0 && command.contents.every(byte => validInteger(byte) && byte <= 255), 'I/O bytes');
    if (command.kind === 'write') check(validInteger(command.lba), 'write extent');
  }
  private projectDevices(devices: readonly IoSnapshotDevice[], requests: readonly IoSnapshotRequest[], process: (pid: Pid) => ProcessControlBlock | undefined): Device[] {
    return devices.map(device => ({ id: device.id, displayName: device.displayName, mode: device.defaultMode, latency: device.latency,
      kind: device.driver.kind === 'net0' ? 'network' : device.driver.kind === 'character_output' || device.driver.kind === 'printer_fixture' ? 'character' : 'block',
      busy: device.activeRequestId !== null || requests.some(req => req.device === device.id && req.service.kind === 'storage'),
      queue: [...new Set(requests.filter(req => req.device === device.id && req.owner.kind === 'actor' && !req.wakeable).flatMap(req => {
        if (req.owner.kind !== 'actor') return []; const pcb = process(req.owner.actor.pid);
        return pcb?.state === 'waiting' && pcb.blockedOn?.kind === 'io' && pcb.blockedOn.device === device.id ? [pcb.pid] : [];
      }))].sort((a, b) => a - b) }));
  }
  private refreshDevices(): void { this.devices.splice(0, this.devices.length, ...this.projectDevices(this.data.devices, this.data.requests, pid => this.host.process(pid))); }
}

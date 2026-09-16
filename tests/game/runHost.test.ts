import { AFFLICTION_TABLE, TERMINATION_FOR_AFFLICTION } from '../../src/game/afflictions/table';
import { describe, expect, it, vi } from 'vitest';
import { asPid, asTick, createKernel, type KernelEvent } from '@kernel/index';
import type { LegRunner } from '@game/LegRunner';
import { CommandBus } from '@game/CommandBus';
import { RunDirector } from '@game/RunDirector';
import { LegSandbox } from '@game/LegSandbox';
import { createRunStore, createTelemetryStore } from '@game/runStore';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStreams, saveRunStreams } from '@game/replay/types';
import { createHeadlessSetupContext, type ConvoyBindings } from '@game/replay/headlessLegs';
import { acquire, tickAfflictions } from '@game/afflictions/AfflictionClock';
import { buildSaveFile, verify } from '@game/save';
import { resumeRun } from '@game/persist/LoadService';
import { livePolicyBinding } from '@game/travel/policyBinding';
import { paceSpawnTransform } from '@game/travel/workload';
import { PACE_TABLE } from '@game/travel/paceRations';
import { createRunHost } from '@app/RunHost';
import { sinkOverBus } from '@app/commandSinkAdapter';
import type { DifficultyTier, Leg, Pace } from '@game/types';
import type { EpitaphCopySource } from '@game/convoy/derezz';
import type { CrossingDef } from '@game/crossing/Crossing';
import { createSyntheticLeg, syntheticConfig } from './fixtures/syntheticLeg';

type LiveKernel = ReturnType<typeof createKernel>;
function hostFixture() {
  const order: string[] = [];
  let kernel = createKernel(syntheticConfig(51), { checkInvariants: true });
  const store = createRunStore(initialRunState(51, 'shell', 'operator'));
  const telemetry = createTelemetryStore({ tick: 0, cpuUtilisation: 0, faultRate: 0, thrashingThreshold: 200,
    scheduler: 'rr', quantum: 4, replacement: 'lru', disk: 'look', allocation: 'first_fit', leg: { title: 'old', index: 0, count: 13 } });
  const subscriptions: ((kernel: LiveKernel | null) => void)[] = [];
  const received: KernelEvent[][] = [];
  const director = {
    complete: false,
    preTick: vi.fn(() => { order.push('pre'); store.mutate(s => { s.legProgress += .01; }); }),
    postTick: vi.fn((_tick: number, events: readonly KernelEvent[]) => { order.push('post'); received.push([...events]); }),
    observeCommands: vi.fn(() => { order.push('commands'); }),
  };
  const runner = {
    get kernel() { return kernel; }, director, currentLeg: createSyntheticLeg({ id: 'fork_fields', index: 1 }), phase: 'travelling',
    onKernelChanged: (listener: (kernel: LiveKernel | null) => void) => { subscriptions.push(listener); listener(kernel); return () => undefined; },
    routeEvents: vi.fn(),
  };
  const bus = new CommandBus({ store, kernel: {
    setScheduler: (id, params) => { order.push('mutate'); kernel.setScheduler(id, params); },
    setReplacementPolicy: id => kernel.setReplacementPolicy(id), setDiskPolicy: id => kernel.setDiskPolicy(id),
    setAllocationStrategy: id => kernel.setAllocationStrategy(id), setDeadlockStrategy: strategy => kernel.setDeadlockStrategy(strategy),
    syscall: request => kernel.syscall(request),
  }, handlers: { useAbility: () => undefined, interaction: () => undefined, terminal: () => undefined } });
  const host = createRunHost({ runner: runner as unknown as LegRunner, commandBus: bus, runStore: store, telemetry });
  return { host, runner, director, bus, store, telemetry, order, received, get kernel() { return kernel; },
    replaceKernel() { const old = kernel; kernel = createKernel(syntheticConfig(52)); subscriptions.forEach(listener => listener(kernel)); return old; } };
}

describe('headless run host', () => {
  it('applies commands before pre/step/post and uses leg-local command and completed-step ticks', () => {
    const f = hostFixture();
    const step = vi.spyOn(f.kernel, 'step').mockImplementationOnce(() => { f.order.push('step'); return []; });
    f.bus.dispatch({ kind: 'set_scheduler', to: 'fcfs' }, { source: 'hud', legId: 'fork_fields' });
    f.host.applyPendingCommands(700);
    f.host.fixedUpdate(700);
    expect(f.order).toEqual(['mutate', 'commands', 'pre', 'step', 'post']);
    expect(f.store.get().decisions[0]?.tick).toBe(0);
    step.mockRestore();
    f.host.fixedUpdate(701);
    expect(f.director.postTick.mock.calls.at(-1)?.[0]).toBe(1);
  });
  it('captures command-time, step-time and post-tick lifecycle events once by seq', () => {
    const f = hostFixture();
    const pid = f.kernel.spawn({ name: 'victim', arrival: 0, pages: 1, burst: 50, service: 100, priority: 5 });
    f.director.postTick.mockImplementationOnce((_tick, events) => {
      f.received.push([...events]);
      const pcb = f.kernel.process(pid);
      if (pcb !== undefined) f.kernel.lifecycle.exit(pcb, 137, 'starvation');
    });
    f.bus.apply({ kind: 'syscall', request: { name: 'getpid', pid: asPid(1), args: [] } }, { source: 'terminal', legId: 'fork_fields' }, f.kernel.tick);
    f.host.fixedUpdate(0);
    const raw = [...f.host.queue.peekRaw()];
    expect(raw.some(event => event.type === 'process.exited' && event.reason === 'starvation')).toBe(true);
    expect(new Set(raw.map(event => event.seq)).size).toBe(raw.length);
    expect(f.received[0]?.some(event => event.type === 'syscall.invoked')).toBe(true);
    const consumed: number[] = [];
    f.host.queue.addWorld({ name: 'world', consume: event => consumed.push(event.seq) });
    f.host.routeEvents();
    expect(new Set(consumed).size).toBe(consumed.length);
    expect(f.host.queue.peekRaw()).toEqual([]);
  });
  it('publishes both stores once per frame after several ticks and routes after flush', () => {
    const f = hostFixture(); const calls: string[] = [];
    f.store.subscribe(() => calls.push('run')); f.telemetry.subscribe(() => calls.push('telemetry'));
    f.host.queue.addHud({ name: 'hud', beginFrame: () => calls.push('route'), consume: () => undefined });
    for (let tick = 0; tick < 5; tick++) { f.host.applyPendingCommands(tick); f.host.fixedUpdate(tick); }
    expect(calls).toEqual([]);
    f.host.flushState(); f.host.routeEvents();
    expect(calls).toEqual(['run', 'telemetry', 'route']);
    expect(f.telemetry.get().tick).toBe(5);
    expect(f.telemetry.get().leg).toEqual({ title: 'Synthetic leg', index: 1, count: 13 });
  });
  it('reads live policy ids, including changes since kernel construction', () => {
    const f = hostFixture();
    f.kernel.setScheduler('priority_aging', { quantum: 13 });
    f.kernel.setReplacementPolicy('clock'); f.kernel.setDiskPolicy('sstf'); f.kernel.setAllocationStrategy('best_fit');
    f.host.flushState();
    expect(f.telemetry.get()).toMatchObject({ scheduler: 'priority_aging', quantum: 13, replacement: 'clock', disk: 'sstf', allocation: 'best_fit' });
  });
  it('subscribes to a replacement kernel before between-frame terminal commands', () => {
    const f = hostFixture(); const old = f.replaceKernel();
    old.syscall({ name: 'getpid', pid: asPid(1), args: [] }); expect(f.host.queue.peekRaw()).toEqual([]);
    f.bus.apply({ kind: 'syscall', request: { name: 'getpid', pid: asPid(1), args: [] } }, { source: 'terminal', legId: 'fork_fields' }, f.kernel.tick);
    expect(f.host.queue.peekRaw().some(event => event.type === 'syscall.invoked')).toBe(true);
    f.host.fixedUpdate(999); expect(f.kernel.tick).toBe(1); expect(old.tick).toBe(0);
  });
  it.each(['depot', 'reclamation', 'crossing', 'complete'])('does not advance modal phase%s', phase => {
    const f = hostFixture(); f.runner.phase = phase; f.host.fixedUpdate(0);
    expect(f.kernel.tick).toBe(0); expect(f.director.preTick).not.toHaveBeenCalled();
  });
});

const epitaphs: EpitaphCopySource = { templates: reason => [{ id: `fixture.${reason}`, reason,
  inscription: '{NAME} stopped.', cause: reason, codexEntry: `fixture.${reason}` }] };
function directorFixture(options: { tier?: DifficultyTier; pace?: Pace; onCredit?: boolean; maxTicks?: number; service?: number; leg?: Partial<Leg> } = {}) {
  const store = createRunStore(initialRunState(743, 'daemon', options.tier ?? 'operator'));
  store.mutate(run => {
    run.legIndex = 6;
    run.resources = { cycles: 10000, quota: 10000, blocks: 1000, bandwidth: 100 };
    run.policy = { pace: options.pace ?? 'steady', rations: 'standard', degreeOfMultiprogramming: 8 };
  });
  const leg: Leg = { ...createSyntheticLeg({ id: 'the_gridlock', index: 6, processes: 0,
    service: [options.service ?? 10000, (options.service ?? 10000) + 1],
    config: { enabledSubsystems: ['process', 'scheduler', 'memory', 'sync'], totalFrames: 128 } }), ...options.leg };
  const originalConfig = leg.kernelConfig(store.get());
  const kernel = createKernel({ ...originalConfig, schedulerParams: { ...originalConfig.schedulerParams, quantum: PACE_TABLE[store.get().policy.pace].quantum } }, { checkInvariants: true });
  const streams = createRunStreams(store.get().seed);
  const bindings: ConvoyBindings = new Map();
  leg.populate(createHeadlessSetupContext(kernel, store.get(), streams.leg.fork(leg.id), bindings, paceSpawnTransform(store.get().policy.pace)));
  store.mutate(run => { for (const member of run.convoy) member.pid = bindings.get(member.id) ?? null; });
  livePolicyBinding.apply(kernel, store.get().policy);
  const onDerezz = vi.fn(); const onLegEvent = vi.fn(); const onRunnerFailure = vi.fn();
  const director = new RunDirector({ leg, store, kernel, streams, bindings, epitaphs,
    sandbox: new LegSandbox(leg, () => undefined), maxTicks: options.maxTicks ?? 1000,
    onCredit: options.onCredit ?? false, callbacks: { onDerezz, onLegEvent, onRunnerFailure } });
  const bus = new CommandBus({ store, kernel, admit: (command, origin, at) => director.admit(command, origin, at),
    handlers: { useAbility: (member, target, at) => director.useAbility(member, target, at),
      interaction: (id, anchor, at) => { director.interaction(id, anchor, at); }, terminal: (line, at) => director.terminal(line, at) } });
  const step = () => {
    director.observeCommands(bus.drain(kernel.tick));
    director.preTick(kernel.tick);
    if (director.tickLimitReached) return [];
    const events = kernel.step();
    director.postTick(kernel.tick, events);
    return events;
  };
  const crossing: CrossingDef = { id: 'fixture-crossing', legId: leg.id, lockId: 'vault', kind: 'mutex', ordered: true, anchor: 'fixture', crosser: 'lumen' };
  return { store, leg, kernel, streams, bindings, director, bus, step, crossing, onDerezz, onLegEvent, onRunnerFailure };
}

describe('RunDirector admission and travel', () => {
  it('refuses an unaffordable tier policy command before its kernel mutation', () => {
    const f = directorFixture({ tier: 'architect' });
    f.store.mutate(run => { run.resources.cycles = 14; });
    const setter = vi.spyOn(f.kernel, 'setScheduler');
    const outcome = f.bus.apply({ kind: 'set_scheduler', to: 'fcfs' }, { source: 'hud', legId: f.leg.id }, f.kernel.tick);
    expect(outcome.refused).toMatch(/Insufficient/);
    expect(setter).not.toHaveBeenCalled(); expect(f.kernel.invariantState().schedulerId).toBe('rr');
    expect(f.store.get().resources.cycles).toBe(14);
    expect(f.store.get().decisions).toHaveLength(1); expect(f.store.get().decisions[0]?.outcome).toBe('costly');
    f.director.dispose();
  });
  it('charges successive synchronous terminal writes immediately and refuses before either cost on underflow', () => {
    const f = directorFixture({ tier: 'kernel_space' });
    f.store.mutate(run => { run.resources.cycles = 100; run.resources.bandwidth = 2; });
    const sink = sinkOverBus(f.bus, f.leg.id, () => f.kernel);
    expect(sink.dispatch({ kind: 'set_scheduler', id: 'priority_aging', params: { quantum: 16 } }, { source: 'terminal', line: 'sched priority_aging -q 16' })).toEqual({ ok: true });
    expect(f.kernel.invariantState().schedulerId).toBe('priority_aging');
    expect(f.store.get().resources).toMatchObject({ cycles: 75, bandwidth: 0 });
    expect(sink.dispatch({ kind: 'set_rations', rations: 'lean' }, { source: 'terminal', line: 'rations lean' })).toMatchObject({ ok: false });
    expect(f.store.get().policy.rations).toBe('standard');
    expect(f.store.get().resources).toMatchObject({ cycles: 75, bandwidth: 0 });
    expect(f.store.get().decisions.map(decision => decision.tick)).toEqual([0, 0]);
    f.director.dispose();
  });
  it('checks each command against the remaining ledger within one drained batch', () => {
    const f = directorFixture({ tier: 'architect' });
    f.store.mutate(run => { run.resources.cycles = 15; });
    f.bus.dispatch({ kind: 'set_pace', to: 'aggressive' }, { source: 'hud', legId: f.leg.id });
    f.bus.dispatch({ kind: 'set_rations', to: 'lean' }, { source: 'hud', legId: f.leg.id });
    const outcomes = f.bus.drain(f.kernel.tick); f.director.observeCommands(outcomes);
    expect(outcomes.map(result => result.refused === null)).toEqual([true, false]);
    expect(f.store.get().policy).toMatchObject({ pace: 'aggressive', rations: 'standard' });
    expect(f.store.get().resources.cycles).toBe(0); expect(f.kernel.invariantState().schedulerParams.quantum).toBe(4);
    f.director.dispose();
  });
  it.each([
    ['conservative', 134, 126, 335, 13], ['steady', 80, 200, 200, 8],
    ['aggressive', 54, 360, 135, 5], ['reckless', 39, 704, 97.5, 4],
  ] as const)('integrates real kernel travel at %s with the R8 totals', (pace, ticks, cycles, quota, draws) => {
    const f = directorFixture({ pace });
    while (!f.director.complete) f.step();
    expect(f.kernel.tick).toBe(ticks); expect(f.director.travel.segmentsDone).toBe(80);
    expect(10000 - f.store.get().resources.cycles).toBeCloseTo(cycles, 8);
    expect(10000 - f.store.get().resources.quota).toBeCloseTo(quota, 8);
    expect(f.director.travel.drawsFired).toBe(draws); expect(f.store.get().legProgress).toBe(1);
    expect(f.store.get().tombstones).toHaveLength(0);
    f.director.dispose();
  });
  it('activates credit on the first unaffordable mandatory tick and applies its ordered integrity drain', () => {
    const f = directorFixture(); f.store.mutate(run => { run.resources.cycles = 3; });
    f.step(); expect(f.director.travel.onCredit).toBe(false); expect(f.store.get().resources.cycles).toBe(.5);
    f.step(); expect(f.director.travel.onCredit).toBe(true); expect(f.store.get().resources.cycles).toBe(.5);
    expect(f.director.travel.segmentsDone).toBe(1.6); expect(f.store.get().policy.pace).toBe('conservative');
    expect(f.store.get().convoy.find(member => member.id === 'kestrel')?.integrity).toBe(99.7);
    expect(f.store.get().convoy.filter(member => member.id !== 'kestrel').map(member => member.integrity)).toEqual([100, 100, 100, 100]);
    expect(f.bus.apply({ kind: 'set_pace', to: 'steady' }, { source: 'hud', legId: f.leg.id }, f.kernel.tick).refused).not.toBeNull();
    f.director.dispose();
  });
  it('forces starved rations at zero quota and refuses an attempted increase before mutation', () => {
    const f = directorFixture(); f.store.mutate(run => { run.resources.quota = 0; });
    expect(f.bus.apply({ kind: 'set_rations', to: 'generous' }, { source: 'hud', legId: f.leg.id }, f.kernel.tick).refused).toMatch(/Reclaim/);
    f.step();
    expect(f.store.get().resources.quota).toBe(0); expect(f.store.get().policy.rations).toBe('starved');
    expect(f.kernel.memorySubsystem.framePolicy.rations).toBe('starved');
    expect(f.store.get().convoy.every(member => member.integrity <= 99)).toBe(true);
    f.store.mutate(run => { run.resources.quota = 20; });
    expect(f.bus.apply({ kind: 'set_rations', to: 'standard' }, { source: 'hud', legId: f.leg.id }, f.kernel.tick).refused).toBeNull();
    f.director.dispose();
  });
  it("drains an affliction acquired by this tick's rations roll in that same tick", () => {
    const f = directorFixture(); f.store.mutate(run => { run.policy.rations = 'lean'; });
    vi.spyOn(f.streams.events, 'chance').mockReturnValue(true);
    f.step();
    expect(f.store.get().convoy.every(member => member.afflictions.some(a => a.id === 'cache_thrash'))).toBe(true);
    for (const member of f.store.get().convoy) expect(member.integrity).toBeCloseTo(99.2, 10);
    f.director.dispose();
  });
  it('stops at maxTicks without another charge or kernel step and reports the runner diagnostic once', () => {
    const f = directorFixture({ maxTicks: 1 }); f.step();
    const resources = { ...f.store.get().resources };
    f.step(); f.step();
    expect(f.kernel.tick).toBe(1); expect(f.director.travel.ticksElapsed).toBe(1);
    expect(f.store.get().resources).toEqual(resources); expect(f.onRunnerFailure).toHaveBeenCalledTimes(1);
    expect(f.onRunnerFailure.mock.calls[0]?.[0]).toMatch(/maxTicks/);
    f.director.dispose();
  });
  it('uses the replay entry credit state for admission instead of the completed live state', () => {
    const live = directorFixture({ onCredit: true, pace: 'conservative' });
    const replay = directorFixture();
    const hooks = live.director.hooks();
    hooks.isComplete?.(replay.kernel.tick, replay.kernel, replay.store.get());
    expect(hooks.admit?.({ kind: 'set_pace', to: 'aggressive' }, { source: 'replay', legId: replay.leg.id }, replay.kernel.tick)).toEqual({ ok: true });
    expect(live.director.travel.onCredit).toBe(true); expect(live.store.get().policy.pace).toBe('conservative');
    live.director.dispose(); replay.director.dispose();
  });
  it('applies event floors without letting stocks become negative', () => {
    const f = directorFixture({ leg: { eventTable: [{ id: 'loss', weight: 100, title: 'Fixture', narration: 'Fixture', targets: null,
      inflicts: null, onlyIf: null, resourceDelta: { cycles: -1e6, quota: -1e6, blocks: -1e6, bandwidth: -1e6 } }] } });
    for (let tick = 0; tick < 10; tick++) f.step();
    expect(f.store.get().resources).toEqual({ cycles: 0, quota: 0, blocks: 0, bandwidth: 0 });
    f.step(); expect(f.director.travel.onCredit).toBe(true);
    expect(Object.values(f.store.get().resources).every(value => value >= 0)).toBe(true);
    f.director.dispose();
  });
  it('cures only matching policy and sufficient degree remedies in the accepted batch', () => {
    const f = directorFixture();
    f.store.mutate(run => { const member = run.convoy[0]!; acquire(member, 'starvation', asTick(0)); acquire(member, 'thrashing', asTick(0)); acquire(member, 'cache_thrash', asTick(0)); });
    f.bus.dispatch({ kind: 'set_scheduler', to: 'priority_aging' }, { source: 'hud', legId: f.leg.id });
    f.bus.dispatch({ kind: 'set_degree', to: 6 }, { source: 'hud', legId: f.leg.id });
    f.director.observeCommands(f.bus.drain(f.kernel.tick));
    expect(f.store.get().convoy[0]?.afflictions.map(a => a.id)).toEqual(['cache_thrash']);
    f.bus.dispatch({ kind: 'set_pace', to: 'conservative' }, { source: 'hud', legId: f.leg.id });
    f.director.observeCommands(f.bus.drain(f.kernel.tick));
    expect(f.store.get().convoy[0]?.afflictions).toEqual([]);
    f.director.dispose();
  });
});

describe('RunDirector death ordering and event observation', () => {
  it('rebases carried affliction ages exactly once at the boundary and preserves them through saves', () => {
    const f = directorFixture();
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'lumen')!, 'bit_rot', asTick(0)); });
    while (!f.director.complete) f.step();
    expect(f.kernel.tick).toBe(80);
    f.director.finishAfflictionClock();
    expect(f.store.get().convoy.find(member => member.id === 'lumen')?.afflictions[0]).toMatchObject({ acquiredAtTick: -80, fatalAfter: 400 });
    f.director.finishAfflictionClock();
    expect(f.store.get().convoy.find(member => member.id === 'lumen')?.afflictions[0]?.acquiredAtTick).toBe(-80);
    const file = buildSaveFile({ run: structuredClone(f.store.get()), kernel: null, rngStates: saveRunStreams(f.streams), savedAtIso: '2026-09-16T00:00:00Z' });
    expect(verify(file)).toBe(true);
    const resumed = resumeRun(file, { buildKernel: run => createKernel(f.leg.kernelConfig(run)), populate: () => undefined });
    expect(resumed.kind).toBe('ok');
    if (resumed.kind !== 'ok') throw new Error(resumed.message);
    const survivor = resumed.run.convoy.find(member => member.id === 'lumen')!;
    expect(survivor.afflictions[0]?.acquiredAtTick).toBe(-80);
    expect(tickAfflictions([survivor], asTick(319)).fatal).toEqual([]);
    expect(tickAfflictions([survivor], asTick(320)).fatal).toEqual([{ member: 'lumen', id: 'bit_rot' }]);
    f.director.dispose();
  });
  it('uses the expiring fatal clock even when rations also exhaust integrity that tick', () => {
    const f = directorFixture();
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'lumen')!, 'stack_overflow', asTick(0)); });
    for (let tick = 0; tick < 59; tick++) f.step();
    f.store.mutate(run => {
      const member = run.convoy.find(candidate => candidate.id === 'lumen')!;
      member.integrity = .5; member.status = 'critical'; acquire(member, 'thrashing', f.kernel.tick);
      run.policy.rations = 'starved';
    });
    f.step();
    expect(f.store.get().tombstones).toHaveLength(1);
    expect(f.store.get().tombstones[0]).toMatchObject({ member: 'lumen', reason: 'protection_fault', tick: 60 });
    expect(f.director.allEvents.filter(event => event.type === 'process.exited' && event.pid === f.bindings.get('lumen')))
      .toMatchObject([{ type: 'process.exited', reason: 'protection_fault' }]);
    f.director.dispose();
  });
  it('terminates a still-live bound pid and emits exactly one epitaph across repeated postTick input', () => {
    const f = directorFixture(); for (let tick = 0; tick < 10; tick++) f.step();
    f.store.mutate(run => { const member = run.convoy.find(candidate => candidate.id === 'lumen')!; member.integrity = .1; member.status = 'critical'; acquire(member, 'bit_rot', f.kernel.tick); });
    const events = f.step();
    f.director.postTick(f.kernel.tick, [...events, ...f.director.allEvents]);
    f.director.postTick(f.kernel.tick, [...events, ...f.director.allEvents]);
    expect(f.store.get().tombstones).toHaveLength(1);
    expect(f.store.get().tombstones[0]).toMatchObject({ reason: 'storage_corruption', tick: 11 });
    expect(f.onDerezz.mock.calls).toEqual([['begin'], ['tombstone']]);
    const deaths = f.director.allEvents.filter(event => event.type === 'process.exited' && event.pid === f.bindings.get('lumen'));
    expect(deaths).toHaveLength(1);
    expect(new Set(f.director.allEvents.map(event => event.seq)).size).toBe(f.director.allEvents.length);
    expect(f.store.get().convoy.find(member => member.id === 'lumen')).toMatchObject({ pid: null, status: 'derezzed', integrity: 0 });
    f.director.dispose();
  });
  it('discards a pending Vesper at tick 5 while retaining the pathology in the epitaph', () => {
    const f = directorFixture(); const pid = f.bindings.get('vesper')!;
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'vesper')!, 'bit_rot', asTick(5 - AFFLICTION_TABLE.bit_rot.fatalAfter!)); });
    for (let tick = 0; tick < 4; tick++) f.step();
    expect(f.kernel.process(pid)).toMatchObject({ state: 'new', arrivalTick: 8, terminationReason: null });
    expect(f.store.get().tombstones).toEqual([]);
    const events = f.step();
    expect(f.kernel.tick).toBe(5);
    expect(f.kernel.process(pid)).toMatchObject({ state: 'terminated', exitCode: 137, terminationReason: 'killed_by_parent' });
    expect(f.store.get().tombstones).toMatchObject([{ member: 'vesper', tick: 5, reason: 'storage_corruption' }]);
    expect(f.store.get().convoy.find(member => member.id === 'vesper')).toMatchObject({
      pid: null, status: 'derezzed', integrity: 0, epitaph: { tick: 5, reason: 'storage_corruption' },
    });
    // Pending kill emits a direct state transition and syscall result; it has no process.exited event.
    const targetEvents = () => f.director.allEvents.filter(event => ('pid' in event && event.pid === pid)
      || (event.type === 'syscall.invoked' && event.request.name === 'kill' && event.request.args[0] === pid));
    expect(targetEvents()).toMatchObject([
      { type: 'process.state_changed', tick: 5, pid, from: 'new', to: 'terminated' },
      { type: 'syscall.invoked', tick: 5, request: { name: 'kill', pid: 1, args: [pid, 9] }, result: { ok: true, value: null } },
    ]);
    f.director.postTick(f.kernel.tick, [...events, ...f.director.allEvents]);
    while (f.kernel.tick < 10) f.step();
    expect(f.kernel.process(pid)?.state).toBe('terminated');
    expect(targetEvents().map(event => event.type)).toEqual(['process.state_changed', 'syscall.invoked']);
    expect(f.store.get().tombstones).toHaveLength(1);
    expect(f.onDerezz.mock.calls).toEqual([['begin'], ['tombstone']]);
    f.director.dispose();
  });
  it('keeps the chosen pathology on the lifecycle exit after Vesper has arrived', () => {
    const f = directorFixture(); const pid = f.bindings.get('vesper')!;
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'vesper')!, 'bit_rot', asTick(11 - AFFLICTION_TABLE.bit_rot.fatalAfter!)); });
    for (let tick = 0; tick < 10; tick++) f.step();
    expect(f.kernel.process(pid)?.arrivalTick).toBe(8);
    expect(['ready', 'running', 'waiting']).toContain(f.kernel.process(pid)?.state);
    const events = f.step();
    expect(f.kernel.tick).toBe(11);
    expect(f.kernel.process(pid)).toMatchObject({ state: 'zombie', exitCode: 137, terminationReason: 'storage_corruption' });
    expect(f.store.get().tombstones).toMatchObject([{ member: 'vesper', tick: 11, reason: 'storage_corruption' }]);
    f.director.postTick(f.kernel.tick, [...events, ...f.director.allEvents]);
    f.step();
    expect(f.director.allEvents.filter(event => event.type === 'process.exited' && event.pid === pid))
      .toMatchObject([{ type: 'process.exited', tick: 11, pid, exitCode: 137, reason: 'storage_corruption' }]);
    expect(f.director.allEvents.filter(event => event.type === 'syscall.invoked' && event.request.name === 'kill' && event.request.args[0] === pid)).toEqual([]);
    expect(f.store.get().tombstones).toHaveLength(1);
    expect(f.onDerezz.mock.calls).toEqual([['begin'], ['tombstone']]);
    f.director.dispose();
  });
  it('does not turn a normal kernel completion into a convoy death', () => {
    const f = directorFixture({ service: 1 });
    for (let tick = 0; tick < 25; tick++) f.step();
    expect(f.director.allEvents.some(event => event.type === 'process.exited' && event.reason === 'normal_exit')).toBe(true);
    expect(f.store.get().tombstones).toEqual([]); expect(f.store.get().convoy.every(member => member.status !== 'derezzed')).toBe(true);
    f.director.dispose();
  });
  it('deduplicates command-time events and supplied step events by sequence', () => {
    const f = directorFixture();
    const pid = f.bindings.get('lumen')!;
    f.bus.apply({ kind: 'syscall', request: { name: 'getpid', pid, args: [] } }, { source: 'terminal', legId: f.leg.id }, f.kernel.tick);
    const events = f.step();
    const before = f.director.allEvents.length;
    f.director.postTick(f.kernel.tick, [...events, ...events]);
    expect(f.director.allEvents.length).toBe(before);
    expect(f.director.allEvents.filter(event => event.type === 'syscall.invoked')).toHaveLength(1);
    f.director.dispose();
  });
});

describe('RunDirector prepaid crossing ticks', () => {
  it('charges the quote once and runs affliction ticks without travel movement or ordinary quota', () => {
    const f = directorFixture();
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'lumen')!, 'bit_rot', asTick(0)); });
    const before = { ...f.store.get().resources };
    f.director.openCrossing(f.crossing);
    const result = f.director.resolveCrossing(f.crossing, 'spin');
    expect(result.attempts).toBe(1);
    expect(f.kernel.tick).toBe(result.quote.ticksCost); expect(f.kernel.tick).toBe(4);
    expect(f.director.travel).toMatchObject({ segmentsDone: 0, ticksElapsed: 0, drawsFired: 0 });
    expect(f.store.get().resources.quota).toBe(before.quota);
    expect(f.store.get().resources.cycles).toBe(before.cycles - result.quote.cyclesCost);
    expect(f.store.get().convoy.find(member => member.id === 'lumen')?.integrity).toBeCloseTo(98.8, 10);
    f.director.dispose();
  });
  it('retains emergency-credit integrity exposure while crossing movement and costs are prepaid', () => {
    const f = directorFixture({ onCredit: true, pace: 'conservative' });
    const before = { ...f.store.get().resources };
    const result = f.director.resolveCrossing(f.crossing, 'spin');
    expect(result.attempts).toBe(1); expect(f.kernel.tick).toBe(4);
    expect(f.store.get().convoy.find(member => member.id === 'kestrel')?.integrity).toBeCloseTo(98.8, 10);
    expect(f.store.get().resources.cycles).toBe(before.cycles - result.quote.cyclesCost);
    expect(f.store.get().resources.quota).toBe(before.quota);
    expect(f.director.travel.segmentsDone).toBe(0);
    f.director.dispose();
  });
  it('builds all tombstones and lifecycle exits when crossing drains kill the last living members', () => {
    const f = directorFixture(); for (let tick = 0; tick < 10; tick++) f.step();
    f.store.mutate(run => { for (const member of run.convoy) { member.integrity = .1; member.status = 'critical'; acquire(member, 'bit_rot', f.kernel.tick); } });
    const before = f.kernel.tick;
    const result = f.director.resolveCrossing(f.crossing, 'spin');
    expect(result.casualties).toHaveLength(5); expect(f.director.failed).toBe(true);
    expect(f.store.get().tombstones).toHaveLength(5);
    expect(f.director.allEvents.filter(event => event.type === 'process.exited' && event.reason === 'storage_corruption')).toHaveLength(5);
    expect(f.kernel.tick).toBe(before + 1);
    f.director.dispose();
  });
  it('refuses an unaffordable paid crossing before costs, ticks, event draws or success rolls', () => {
    const f = directorFixture(); f.store.mutate(run => { run.resources.cycles = 0; });
    const rng = f.streams.crossing.save(); const eventsRng = f.streams.events.save(); const resources = { ...f.store.get().resources };
    const result = f.director.resolveCrossing(f.crossing, 'spin');
    expect(result.refused).toMatch(/Insufficient/); expect(result.attempts).toBe(0);
    expect(f.kernel.tick).toBe(0); expect(f.streams.crossing.save()).toEqual(rng); expect(f.streams.events.save()).toEqual(eventsRng);
    expect(f.store.get().resources).toEqual(resources); expect(f.director.travel.onCredit).toBe(false);
    f.director.dispose();
  });
  it('uses exactly the wait crossing draws without travel cadence draws', () => {
    const event: Leg['eventTable'][number] = { id: 'fixture', weight: 100, title: 'Fixture', narration: 'Fixture', targets: null, inflicts: null, onlyIf: null, resourceDelta: { blocks: 1 } };
    const f = directorFixture({ leg: { eventTable: [event] } });
    const result = f.director.resolveCrossing(f.crossing, 'wait');
    expect(f.kernel.tick).toBe(40); expect(result.eventsDrawn).toEqual(['fixture', 'fixture', 'fixture', 'fixture']);
    expect(f.store.get().resources.blocks).toBe(1004); expect(f.director.travel.drawsFired).toBe(0);
    expect(f.store.get().resources.quota).toBe(9900); expect(f.store.get().resources.cycles).toBe(10000);
    f.director.dispose();
  });
});


describe('terminal sink over the live bus', () => {
  it('returns the real getpid syscall result synchronously at the active kernel tick', () => {
    const f = hostFixture();
    f.kernel.run(3);
    const sink = sinkOverBus(f.bus, 'fork_fields', () => f.kernel);
    const result = sink.dispatch({ kind: 'syscall', request: { name: 'getpid', pid: asPid(1), args: [] } }, { source: 'terminal', line: 'syscall getpid --pid 1' });
    expect(result).toEqual({ ok: true, syscall: { ok: true, value: 1 } });
    expect(f.store.get().decisions).toHaveLength(1);
    expect(f.store.get().decisions[0]).toMatchObject({ tick: 3, legId: 'fork_fields', kind: 'syscall' });
    expect(f.bus.drain(f.kernel.tick)).toEqual([]);
    expect(f.host.queue.peekRaw().filter(event => event.type === 'syscall.invoked')).toHaveLength(1);
    const firstKernel = f.kernel;
    f.replaceKernel(); f.kernel.run(2);
    expect(sink.dispatch({ kind: 'syscall', request: { name: 'getpid', pid: asPid(1), args: [] } }, { source: 'terminal', line: 'syscall getpid --pid 1' }))
      .toEqual({ ok: true, syscall: { ok: true, value: 1 } });
    expect(firstKernel.tick).toBe(3);
    expect(f.store.get().decisions.at(-1)?.tick).toBe(2);
  });

  it.each([
    ['agingInterval', { agingInterval: 0 }],
    ['levelQuanta', { levelQuanta: [2, 4, 8] }],
    ['preemptive', { preemptive: false }],
    ['starvationThreshold', { starvationThreshold: 50 }],
    ['starvationFatalThreshold', { starvationFatalThreshold: 100 }],
  ] satisfies readonly (readonly [string, Partial<import('../../src/kernel/types').SchedulerParams>])[])
  ('refuses unsupported scheduler parameter %s without recording or mutating', (key, params) => {
    const f = hostFixture();
    const before = f.kernel.snapshot();
    const set = vi.spyOn(f.kernel, 'setScheduler');
    const result = sinkOverBus(f.bus, 'fork_fields', () => f.kernel).dispatch(
      { kind: 'set_scheduler', id: 'priority_aging', params: { quantum: 7, ...params } },
      { source: 'terminal', line: `sched priority_aging ${key}` },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unsupported scheduler parameter was accepted');
    expect(result.message).toContain(key); expect(result.message).toContain('man sched');
    expect(set).not.toHaveBeenCalled(); expect(f.store.get().decisions).toEqual([]);
    expect(f.kernel.snapshot()).toEqual(before);
  });

  it('accepts quantum and maps the requested deadlock strategy through the same recorded bus', () => {
    const f = hostFixture();
    const sink = sinkOverBus(f.bus, 'fork_fields', () => f.kernel);
    expect(sink.dispatch({ kind: 'set_scheduler', id: 'rr', params: { quantum: 7 } }, { source: 'terminal', line: 'sched rr quantum=7' })).toEqual({ ok: true });
    expect(f.kernel.invariantState().schedulerParams.quantum).toBe(7);
    const set = vi.spyOn(f.kernel, 'setDeadlockStrategy');
    expect(sink.dispatch({ kind: 'set_deadlock_strategy', strategy: 'avoid' }, { source: 'terminal', line: 'deadlock avoid' })).toEqual({ ok: true });
    expect(set).toHaveBeenCalledExactlyOnceWith('avoid');
    expect(f.store.get().decisions.map(record => record.kind)).toEqual(['set_scheduler', 'set_deadlock_strategy']);
    expect(f.bus.drain(f.kernel.tick)).toEqual([]);
  });
});

describe('crossing fatal clocks', () => {
  it.each(['starvation', 'thrashing', 'livelock', 'bit_rot', 'stack_overflow', 'interrupt_storm'] as const)
  ('expires %s at its carried deadline during a prepaid wait', id => {
    const f = directorFixture(); const deadline = AFFLICTION_TABLE[id].fatalAfter!;
    f.store.mutate(run => { acquire(run.convoy.find(member => member.id === 'sable')!, id, asTick(5 - deadline)); });
    const result = f.director.resolveCrossing(f.crossing, 'wait');
    const tombstone = f.store.get().tombstones.find(stone => stone.member === 'sable');
    expect(tombstone).toMatchObject({ tick: 5, reason: TERMINATION_FOR_AFFLICTION[id] });
    expect(result.casualties).toContain('sable'); expect(f.kernel.tick).toBe(40);
    expect(f.director.travel.ticksElapsed).toBe(0); f.director.dispose();
  });
});

import { ReplayWorkerHandle } from '../../src/game/workers/ReplayWorkerHandle';
import { describe, expect, it, vi } from 'vitest';
import { asTick, createKernel, type KernelEvent } from '../../src/kernel/index';
import { CommandBus, type KernelMutators } from '../../src/game/CommandBus';
import { LegRunner, type LegEvent, type LegRunnerDeps } from '../../src/game/LegRunner';
import { createRunStore } from '../../src/game/runStore';
import { initialRunState, runReplay } from '../../src/game/replay/runReplay';
import { createRunStreams, saveRunStreams, type ReplayRequest } from '../../src/game/replay/types';
import { resolveHeadlessLeg } from '../../src/game/replay/headlessLegs';
import { hashEventLog } from '../../src/game/replay/hash';
import type { EpitaphCopySource } from '../../src/game/convoy/derezz';
import type { DecisionRecord, Leg, ResourceLedger, RunState } from '../../src/game/types';
import { createSyntheticLeg } from './fixtures/syntheticLeg';

const copy: EpitaphCopySource = { templates: reason => [{ id: reason, reason, inscription: '{NAME} stopped.', cause: 'Synthetic fixture.', codexEntry: `test.${reason}` }] };
function rig(seed = 21, initial?: RunState, overrides: Partial<LegRunnerDeps> = {}) {
  const store = createRunStore(initial ?? initialRunState(seed, 'shell', 'operator'));
  const streams = createRunStreams(seed);
  let runner: LegRunner;
  const kernel: KernelMutators = {
    setScheduler: (id, params) => runner.kernel!.setScheduler(id, params),
    setReplacementPolicy: id => runner.kernel!.setReplacementPolicy(id),
    setDiskPolicy: id => runner.kernel!.setDiskPolicy(id),
    setAllocationStrategy: id => runner.kernel!.setAllocationStrategy(id),
    setDeadlockStrategy: id => runner.kernel!.setDeadlockStrategy(id),
    syscall: request => runner.kernel!.syscall(request),
  };
  const bus = new CommandBus({ store, kernel, admit: (cmd, origin, at) => runner.director!.admit(cmd, origin, at), handlers: {
    useAbility: (id, target, at) => runner.director!.useAbility(id, target, at),
    interaction: (id, anchor, at) => { runner.director!.interaction(id, anchor, at); },
    terminal: (line, at) => runner.director!.terminal(line, at),
  } });
  const notifications: LegEvent[] = [];
  const persist = vi.fn(); const failure = vi.fn(); const kernelChanged = vi.fn();
  runner = new LegRunner({ runStore: store, commandBus: bus, createKernel, streams, onEvent: () => undefined, replay: null, epitaphs: copy,
    persist, buildId: 'wp19-test', savedAtIso: () => '2026-09-16T00:00:00.000Z', throughputTarget: () => 0.1,
    onLegEvent: event => notifications.push(event), codexSignal: vi.fn(), onDerezz: vi.fn(), onFailure: failure, onRunnerFailure: failure, ...overrides });
  runner.onKernelChanged(kernelChanged);
  return { store, streams, bus, runner, notifications, persist, failure, kernelChanged };
}
const options = { maxTicks: 500, stageContext: null } as const;
function tick(r: ReturnType<typeof rig>) {
  const kernel = r.runner.kernel!;
  r.runner.observeCommands(r.bus.drain(kernel.tick));
  r.runner.preTick(kernel.tick);
  if (r.runner.director!.tickLimitReached) return;
  const events = kernel.step();
  r.runner.postTick(kernel.tick, events);
}
function finish(r: ReturnType<typeof rig>) { for (let i = 0; i < 600 && !r.runner.finished; i++) tick(r); expect(r.runner.finished).toBe(true); return r.runner.exit(); }
const travelLeg = (patch: Partial<Leg> = {}) => ({ ...createSyntheticLeg({ id: 'fork_fields', index: 1 }), ...patch });

describe('LegRunner boundaries', () => {
  it('enters with bound pids, a preset quantum, and resets per-leg charges through the store', () => {
    const r = rig(); r.store.mutate(run => { run.resources.bandwidth = 0; run.convoy[0]!.abilityCharges = 0; });
    r.runner.enter(travelLeg(), options);
    expect(r.runner.kernel!.invariantState().schedulerParams.quantum).toBe(8);
    expect(r.store.get().resources.bandwidth).toBe(60);
    expect(r.store.get().convoy.every(member => member.pid !== null && member.abilityCharges > 0)).toBe(true);
    expect(r.runner.phase).toBe('travelling'); expect(r.kernelChanged.mock.calls.at(-1)?.[0]).toBe(r.runner.kernel);
    expect(r.persist.mock.calls[0]?.[0].kernel).toBeNull();
  });
  it('skips Boot Sector travel, never constructs its stage headlessly, and exits once', () => {
    const r = rig(); const stage = vi.fn(() => { throw new Error('headless stage'); });
    r.runner.enter({ ...createSyntheticLeg(), createStage: stage }, options);
    expect(r.runner.finished).toBe(true); expect(r.runner.ticksElapsed).toBe(0);
    const outcome = r.runner.exit(); const balance = { ...r.store.get().resources };
    expect(r.runner.exit()).toBe(outcome); expect(r.store.get().resources).toEqual(balance);
    expect(stage).not.toHaveBeenCalled(); expect(r.store.get().legIndex).toBe(1);
    const card = r.notifications.find(event => event.kind === 'debrief');
    expect(card?.kind === 'debrief' ? card.view.dividend : null).toBe(0);
  });
  it.each(['kernelConfig', 'populate'] as const)('a throwing %s preserves resources and streams and allows the next leg', phase => {
    const r = rig(); const before = { ...r.store.get().resources }; const rng = saveRunStreams(r.streams);
    const leg = travelLeg({ [phase]: () => { throw new Error('broken content'); } });
    r.runner.enter(leg, options);
    expect(r.store.get().resources).toEqual(before); expect(saveRunStreams(r.streams)).toEqual(rng);
    expect(r.store.get().legIndex).toBe(2); expect(r.notifications.some(event => event.kind === 'leg_unavailable')).toBe(true);
    r.runner.enter(createSyntheticLeg({ id: 'the_weave', index: 2 }), options);
    expect(r.runner.kernel).not.toBeNull();
  });
  it('staged update failure disables that stage without changing simulation output', () => {
    const update = vi.fn(() => { throw new Error('bad stage update'); }); const dispose = vi.fn();
    const r = rig(); const leg = travelLeg({ createStage: () => ({ update, dispose, anchor: () => null }) });
    r.runner.enter(leg, { ...options, stageContext: { quality: 'low', run: r.store.get() } });
    r.runner.variableUpdate(1 / 60, 0); r.runner.variableUpdate(1 / 60, 0);
    expect(update).toHaveBeenCalledTimes(1); finish(r); expect(dispose).toHaveBeenCalledTimes(1);
    expect(r.failure).toHaveBeenCalledTimes(1);
  });
  it('evaluate failure produces the sandbox neutral card and still advances the run', () => {
    const r = rig(); r.runner.enter(travelLeg({ evaluate: () => { throw new Error('bad evaluator'); } }), options);
    const result = finish(r); expect(result.debrief.headline).toContain('reduced instrumentation');
    expect(result.objectivesMet).toEqual([]); expect(r.store.get().legIndex).toBe(2);
  });
  it('entry credit and a purchased next-leg checkpoint restore owned state exactly once', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    expect(r.runner.openDepot().buy('journal_checkpoint', null).ok).toBe(true); r.runner.continueTravel(); finish(r);
    const next = createSyntheticLeg({ id: 'the_weave', index: 2 }); r.runner.enter(next, options);
    const boundary = structuredClone(r.store.get()); const rng = saveRunStreams(r.streams);
    for (let i = 0; i < 3; i++) tick(r);
    r.store.mutate(run => { for (const member of run.convoy) { member.integrity = 0; member.status = 'derezzed'; } });
    r.runner.exit();
    expect(r.store.get().resources).toEqual(boundary.resources); expect(r.store.get().convoy).toEqual(boundary.convoy);
    expect(saveRunStreams(r.streams)).toEqual(rng); expect(r.runner.kernel!.tick).toBe(0);
    expect(r.store.get().decisions.filter(record => record.kind === 'checkpoint_rollback')).toHaveLength(1);
    expect(r.store.get().score.correctness).toBe(boundary.score.correctness - 100);
    expect(r.runner.rollbackCheckpoint()).toBe(false);
  });
  it('does not award a second dividend on repeated exit', async () => {
    const r = rig(); r.runner.enter(travelLeg(), options); finish(r);
    const ledger = { ...r.store.get().resources }; const notifications = r.notifications.length;
    r.runner.exit(); expect(r.store.get().resources).toEqual(ledger); expect(r.notifications).toHaveLength(notifications);
    const event = r.notifications.find(value => value.kind === 'debrief');
    expect(event?.kind === 'debrief' ? await event.view.counterfactual : 'missing').toBeNull();
  });
  it('halts at maxTicks through the diagnostic channel without adding a player panic', () => {
    const r = rig(); r.runner.enter(travelLeg(), { ...options, maxTicks: 2 });
    tick(r); tick(r); tick(r);
    expect(r.runner.kernel!.tick).toBe(2); expect(r.runner.finished).toBe(true); expect(r.failure).toHaveBeenCalledTimes(1);
    expect(r.notifications.some(event => event.kind === 'panic')).toBe(false);
  });
});

describe('live and registered headless identity', () => {
  it.each([3, 21, 98])('hashes command-time and post-tick events identically at seed %i', seed => {
    const r = rig(seed); const leg = travelLeg(); r.runner.enter(leg, options);
    const entry = structuredClone(r.runner.replayEntry!);
    while (!r.runner.finished) {
      const at = r.runner.kernel!.tick;
      if (at === 5) r.bus.apply({ kind: 'syscall', request: { name: 'getpid', pid: r.store.get().convoy[0]!.pid!, args: [] } }, { source: 'hud', legId: leg.id }, at);
      if (at === 10) r.bus.dispatch({ kind: 'set_pace', to: 'aggressive' }, { source: 'hud', legId: leg.id });
      tick(r);
    }
    const events: readonly KernelEvent[] = [...r.runner.director!.allEvents];
    const request: ReplayRequest = { seed, discClass: 'shell', difficulty: 'operator', legs: [leg.id], decisions: [...r.store.get().decisions], overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry };
    const expected = hashEventLog(events); r.runner.exit();
    const replay = runReplay(request);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(replay.eventLogHash).toBe(expected);
  });
  it('replays a crossing before the next ordinary tick with its travel charge disabled', () => {
    const r = rig(); const leg = travelLeg(); r.runner.enter(leg, options); const entry = structuredClone(r.runner.replayEntry!);
    const def = { id: 'test-vault', legId: leg.id, lockId: 'vault', kind: 'mutex', ordered: false, anchor: 'vault', crosser: 'lumen' } as const;
    r.runner.registerCrossings([def]); tick(r);
    const before = r.runner.director!.travel.segmentsDone;
    r.runner.resolveCrossing(def, 'monitor');
    expect(r.runner.director!.travel.segmentsDone).toBe(before);
    finish(r);
    const replay = runReplay({ seed: 21, discClass: 'shell', difficulty: 'operator', legs: [leg.id], decisions: r.store.get().decisions, overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(replay.eventLogHash).toBe(hashEventLog(r.runner.director!.allEvents));
  });
  it('records decisions with the leg-local tick', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    r.bus.apply({ kind: 'set_pace', to: 'conservative' }, { source: 'hud', legId: 'fork_fields' }, r.runner.kernel!.tick);
    expect(r.store.get().decisions[0]!.tick).toBe(asTick(0));
  });
});

describe('persisted continuation', () => {
  it('reconstructs reclamation and depot history before restoring an exact provisional kernel', () => {
    const boot = createSyntheticLeg(); const leg = travelLeg(); const original = rig(21);
    original.runner.enter(boot, options); original.runner.exit(); original.runner.enter(leg, options);
    for (let i = 0; i < 10; i++) tick(original);
    const layout = original.runner.openReclamation(); const block = layout.leaked[0];
    if (block === undefined) throw new Error('missing leak');
    original.runner.submitReclamation([{ atSeconds: 3, action: 'collect', blockId: block.id }]); original.runner.continueTravel();
    expect(original.runner.openDepot().buy('quota_lot', null).ok).toBe(true); original.runner.continueTravel();
    for (let i = 0; i < 5; i++) tick(original);
    const saved = original.runner.saveProvisional(); const expected = original.runner.director!.snapshot();
    const next = rig(21); expect(next.runner.resume(saved, [boot, leg], options), JSON.stringify(next.failure.mock.calls)).toBe(true);
    expect(next.runner.kernel!.snapshot()).toEqual(saved.kernel);
    expect(next.store.get()).toEqual(saved.run); expect(saveRunStreams(next.streams)).toEqual(saved.rngStates);
    expect(next.runner.director!.snapshot()).toEqual(expected);
    tick(original); tick(next);
    expect(next.store.get()).toEqual(original.store.get()); expect(next.runner.kernel!.snapshot()).toEqual(original.runner.kernel!.snapshot());
  });
});

describe('recruited identity across boundaries', () => {
  it('leaves the original tombstone without replaying its death onto the replacement at exit', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    for (let i = 0; i < 10; i++) tick(r);
    const pid = r.store.get().convoy.find(member => member.id === 'lumen')!.pid!;
    r.bus.apply({ kind: 'syscall', request: { name: 'kill', pid, args: [pid] } }, { source: 'hud', legId: 'fork_fields' }, r.runner.kernel!.tick);
    tick(r);
    expect(r.store.get().convoy.find(member => member.id === 'lumen')!.status).toBe('derezzed');
    expect(r.runner.openDepot().buy('recruit', 'lumen').ok).toBe(true); r.runner.continueTravel();
    finish(r);
    expect(r.store.get().convoy.find(member => member.id === 'lumen')!.status).toBe('nominal');
    expect(r.store.get().convoy.find(member => member.id === 'lumen')!.name).toBe('LUMEN-2');
    expect(r.store.get().tombstones.filter(stone => stone.member === 'lumen')).toHaveLength(1);
  });
});


describe('RunDirector replay integration', () => {
  it('explicit quantum seven survives a recorded pace change through the real director hooks', async () => {
    const { headlessOf } = await import('../../src/game/replay/headlessLegs');
    const seed = 55;
    const r = rig(seed);
    const leg = createSyntheticLeg({ id: 'fork_fields', index: 1, processes: 2, service: [500, 501], config: { enabledSubsystems: ['process', 'scheduler'] } });
    r.runner.enter(leg, { maxTicks: 200, stageContext: null });
    const director = r.runner.director!;
    const base = director.hooks();
    const observations: { tick: number; quantum: number; pace: string }[] = [];
    const hooks: import('../../src/game/replay/types').ReplayHooks = {
      ...base,
      afterStep: (at, replayKernel, events, replayStore) => {
        base.afterStep?.(at, replayKernel, events, replayStore);
        observations.push({ tick: at, quantum: replayKernel.invariantState().schedulerParams.quantum, pace: replayStore.get().policy.pace });
      },
    };
    const request: ReplayRequest = {
      seed, discClass: 'shell', difficulty: 'operator', legs: [leg.id], maxTicks: 200,
      decisions: [{ tick: asTick(40), legId: leg.id, kind: 'set_pace', choice: 'aggressive', outcome: 'pending', relatedObjective: null }],
      overrides: { quantum: 7, suppressRecordedPolicyChanges: false },
    };
    try {
      const result = runReplay(request, { legs: () => headlessOf(leg, hooks) });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(observations.find(row => row.tick === 40)).toEqual({ tick: 40, quantum: 7, pace: 'steady' });
      expect(observations.find(row => row.tick === 41)).toEqual({ tick: 41, quantum: 7, pace: 'aggressive' });
      expect(observations.filter(row => row.tick > 40).every(row => row.quantum === 7)).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.ticks).toBe(54);
    } finally { director.dispose(); }
  });
});

describe('additional accepted runner lifecycle evidence', () => {
  it.each(['timeout', 'rejected'] as const)('a %s counterfactual resolves both slots to null while retaining the debrief', async failureKind => {
    const worker = new ReplayWorkerHandle();
    const run = vi.spyOn(worker, 'run');
    if (failureKind === 'timeout') run.mockResolvedValue({ ok: false, reason: 'timeout', message: 'Fixture timeout' });
    else run.mockRejectedValue(new Error('Fixture worker rejection'));
    const r = rig(21, undefined, { replay: worker }); r.runner.enter(travelLeg(), options); finish(r);
    const event = r.notifications.find(value => value.kind === 'debrief');
    expect(event?.kind).toBe('debrief');
    if (event?.kind !== 'debrief') throw new Error('missing debrief');
    expect(await event.view.counterfactual).toBeNull(); expect(await event.view.codexCounterfactual).toBeNull();
    expect(event.view.card.headline.length).toBeGreaterThan(0);
    expect(run.mock.calls.length).toBeGreaterThan(0); expect(run.mock.calls.length).toBeLessThanOrEqual(2);
    expect(run.mock.calls.every(call => call[1] === 1500)).toBe(true);
    worker.dispose();
  });
  it('a recruit carries the 60 percent passive, one fewer charge, and binds in the next leg', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    for (let i = 0; i < 10; i++) tick(r);
    const pid = r.store.get().convoy.find(member => member.id === 'lumen')!.pid!;
    r.bus.apply({ kind: 'syscall', request: { name: 'kill', pid, args: [pid] } }, { source: 'hud', legId: 'fork_fields' }, r.runner.kernel!.tick);
    tick(r); expect(r.runner.openDepot().buy('recruit', 'lumen').ok).toBe(true);
    const replacement = r.store.get().convoy.find(member => member.id === 'lumen')!;
    expect(replacement.name).toBe('LUMEN-2'); expect(replacement.integrity).toBe(100); expect(replacement.pid).toBeNull(); expect(replacement.abilityCharges).toBe(1);
    expect(r.runner.recruits.find(member => member.member === 'lumen')?.passiveMultiplier).toBe(0.6);
    r.runner.continueTravel(); finish(r); r.runner.enter(createSyntheticLeg({ id: 'the_weave', index: 2 }), options);
    const rebound = r.store.get().convoy.find(member => member.id === 'lumen')!;
    expect(rebound.pid).not.toBeNull(); expect(rebound.abilityCharges).toBe(1);
    expect(r.store.get().tombstones.filter(stone => stone.member === 'lumen')).toHaveLength(1);
  });
  it('entry and exit callbacks follow the declared order around content and persistence', () => {
    const log: string[] = []; const original = travelLeg();
    const leg = { ...original,
      kernelConfig: (run: RunState) => { log.push('config'); expect(run.resources.bandwidth).toBe(60); return original.kernelConfig(run); },
      populate: (ctx: Parameters<Leg['populate']>[0]) => { log.push('populate'); original.populate(ctx); },
      createStage: () => { log.push('stage'); return { update: () => undefined, anchor: () => null, dispose: () => { log.push('dispose'); } }; },
      evaluate: (ctx: Parameters<Leg['evaluate']>[0]) => { log.push('evaluate'); return original.evaluate(ctx); },
    };
    const r = rig(21, undefined, {
      createKernel: (config, kernelOptions) => { log.push('construct'); expect(config.schedulerParams.quantum).toBe(8); return createKernel(config, kernelOptions); },
      persist: (_input, kind) => { expect(kind).toBe('boundary'); log.push('persist'); },
      throughputTarget: () => { log.push('target'); return 0.1; },
      codexSignal: signal => { if (signal.kind === 'leg_complete') log.push('signal'); },
      onLegEvent: event => { if (event.kind === 'debrief') log.push('debrief'); },
    });
    r.runner.onKernelChanged(kernel => { if (kernel !== null) log.push('kernel-ready'); });
    r.runner.enter(leg, { ...options, stageContext: { quality: 'low', run: r.store.get() } });
    expect(log).toEqual(['config', 'construct', 'populate', 'kernel-ready', 'stage', 'persist']);
    log.length = 0; finish(r);
    expect(log).toEqual(['evaluate', 'target', 'dispose', 'signal', 'debrief', 'persist']);
  });
  it.each([false, true])('floors the outcome before the dividend and preserves ordered deduplication, credit=%s', credit => {
    const initial = initialRunState(21, 'shell', 'operator');
    if (credit) initial.resources.cycles = 90;
    initial.objectivesMet = ['earlier', 'shared']; initial.codexUnlocked = ['known', 'shared-entry'];
    const r = rig(21, initial); const original = travelLeg();
    const leg = { ...original, evaluate: (ctx: Parameters<Leg['evaluate']>[0]) => ({ ...original.evaluate(ctx), resourceDelta: { cycles: -10000 }, objectivesMet: ['shared', 'new', 'new'], codexUnlocked: ['shared-entry', 'new-entry', 'new-entry'] }) };
    r.runner.enter(leg, options);
    while (!r.runner.finished) tick(r);
    expect(r.runner.director!.travel.onCredit).toBe(credit);
    const factor = Math.max(0.6, Math.min(1.4, r.runner.kernel!.snapshot().metrics.scheduling.throughput / 0.1));
    const expectedDividend = 66 * factor * (credit ? 0.75 : 1);
    r.runner.exit(); expect(r.store.get().resources.cycles).toBeCloseTo(expectedDividend, 12);
    expect(r.store.get().objectivesMet).toEqual(['earlier', 'shared', 'new']);
    expect(r.store.get().codexUnlocked).toEqual(['known', 'shared-entry', 'new-entry']);
    const event = r.notifications.find(value => value.kind === 'debrief');
    expect(event?.kind === 'debrief' ? event.view.dividend : null).toBe(expectedDividend);
  });
  it('persisted continuation does not recharge an already consumed journal checkpoint', () => {
    const boot = createSyntheticLeg(); const first = travelLeg(); const second = createSyntheticLeg({ id: 'the_weave', index: 2 });
    const original = rig(); original.runner.enter(boot, options); original.runner.exit(); original.runner.enter(first, options);
    original.runner.openDepot().buy('journal_checkpoint', null); original.runner.continueTravel(); finish(original);
    original.runner.enter(second, options); tick(original);
    original.store.mutate(run => { for (const member of run.convoy) { member.integrity = 0; member.status = 'derezzed'; } });
    original.runner.exit(); tick(original); tick(original);
    const saved = original.runner.saveProvisional();
    const restored = rig(); expect(restored.runner.resume(saved, [boot, first, second], options), JSON.stringify(restored.failure.mock.calls)).toBe(true);
    expect(restored.store.get().decisions.filter(record => record.kind === 'checkpoint_rollback')).toHaveLength(1);
    restored.store.mutate(run => { for (const member of run.convoy) { member.integrity = 0; member.status = 'derezzed'; } });
    expect(restored.runner.rollbackCheckpoint()).toBe(false);
  });
});

describe('complete runner determinism and throughput', () => {
  it('two live runners produce identical outcomes, run states and canonical event hashes', () => {
    const a = rig(55); const b = rig(55); const leg = travelLeg();
    for (const run of [a, b]) {
      run.runner.enter(leg, options);
      while (!run.runner.finished) {
        if (run.runner.kernel!.tick === 10) run.bus.dispatch({ kind: 'set_pace', to: 'aggressive' }, { source: 'hud', legId: leg.id });
        tick(run);
      }
    }
    expect(a.runner.exit()).toEqual(b.runner.exit());
    expect(a.store.get()).toEqual(b.store.get());
    expect(hashEventLog(a.runner.director!.allEvents)).toBe(hashEventLog(b.runner.director!.allEvents));
  });
  it('runs a 200-tick synthetic leg headlessly in under 200 ms', () => {
    const r = rig(8);
    r.store.mutate(run => { run.policy.pace = 'conservative'; });
    const leg = createSyntheticLeg({ id: 'fork_fields', index: 1, service: [1, 2], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
    const start = performance.now();
    r.runner.enter(leg, options);
    while (!r.runner.finished) tick(r);
    const def = { id: 'timed-vault', legId: leg.id, lockId: 'vault', kind: 'mutex', ordered: false, anchor: 'vault', crosser: 'lumen' } as const;
    for (let i = 0; i < 5; i++) r.runner.resolveCrossing(def, 'block');
    expect(r.runner.kernel!.tick).toBe(200);
    r.runner.exit();
    expect(performance.now() - start).toBeLessThan(200);
  });
  it('replays resource actions recorded at the completed travel tick before evaluation', () => {
    const r = rig(12); const leg = travelLeg(); r.runner.enter(leg, options);
    const entry = structuredClone(r.runner.replayEntry!);
    while (!r.runner.finished) tick(r);
    const end = r.runner.kernel!.tick;
    expect(r.runner.openDepot().buy('quota_lot', null).ok).toBe(true);
    const choice = r.store.get().decisions.at(-1)!;
    expect(choice.tick).toBe(end);
    r.runner.exit();
    const replay = runReplay({ seed: 12, discClass: 'shell', difficulty: 'operator', legs: [leg.id], decisions: r.store.get().decisions,
      overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) { expect(replay.diagnostics.skippedDecisions).toBe(0); expect(replay.score).toEqual(r.store.get().score); }
  });
  it('never opens a depot in Drowned Reach', () => {
    const r = rig(); r.runner.enter(createSyntheticLeg({ id: 'drowned_reach', index: 8 }), options);
    expect(() => r.runner.openDepot()).toThrow('no depot');
  });
});

describe('interaction isolation', () => {
  it('reports a throwing handler and preserves the resources and roster', () => {
    const r = rig(); const leg = travelLeg({ interactions: [{ id: 'fault', label: 'Fault', description: '', anchor: 'vault', cost: { cycles: 25 }, enabledWhen: () => true }] });
    r.runner.enter(leg, options);
    r.runner.registerInteraction('fault', run => { run.resources.quota = 0; throw new Error('broken interaction'); });
    const before = structuredClone(r.store.get().resources);
    expect(() => r.bus.apply({ kind: 'interaction', id: 'fault', anchor: 'vault' }, { source: 'world', legId: leg.id }, r.runner.kernel!.tick)).not.toThrow();
    expect(r.store.get().resources).toEqual(before);
    expect(r.store.get().decisions.at(-1)?.outcome).toBe('costly');
    expect(r.failure.mock.calls.at(-1)?.[0].phase).toBe('interaction');
    tick(r); expect(r.runner.kernel!.tick).toBe(1);
  });
});

describe('modal continuation', () => {
  it.each(['depot', 'reclamation'] as const)('restores an open %s without creating an extra decision', modal => {
    const boot = createSyntheticLeg(); const leg = travelLeg(); const original = rig();
    original.runner.enter(boot, options); original.runner.exit(); original.runner.enter(leg, options);
    for (let i = 0; i < 10; i++) tick(original);
    if (modal === 'depot') original.runner.openDepot(); else original.runner.openReclamation();
    const saved = original.runner.saveProvisional(); const snapshot = original.runner.director!.snapshot();
    const restored = rig(); expect(restored.runner.resume(saved, [boot, leg], options)).toBe(true);
    expect(restored.runner.phase).toBe(modal); expect(restored.runner.director!.snapshot()).toEqual(snapshot);
    expect(restored.store.get().decisions).toEqual(saved.run.decisions);
    original.runner.continueTravel(); restored.runner.continueTravel(); tick(original); tick(restored);
    expect(restored.store.get()).toEqual(original.store.get());
  });
});

describe('checkpoint lifetime and persistence', () => {
  const failConvoy = (r: ReturnType<typeof rig>) => r.store.mutate(run => {
    for (const member of run.convoy) { member.integrity = 0; member.status = 'derezzed'; }
  });
  it('forfeits the dividend after a protected retry and consumes protection once', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    expect(r.runner.openDepot().buy('journal_checkpoint', null).ok).toBe(true);
    r.runner.continueTravel(); finish(r);
    r.runner.enter(createSyntheticLeg({ id: 'the_weave', index: 2 }), options);
    tick(r); failConvoy(r); r.runner.exit();
    expect(r.runner.kernel!.tick).toBe(0);
    finish(r);
    const debriefs = r.notifications.filter(event => event.kind === 'debrief');
    const retry = debriefs.at(-1);
    expect(retry?.kind === 'debrief' ? retry.view.dividend : null).toBe(0);
    expect(r.store.get().decisions.filter(record => record.kind === 'checkpoint_rollback')).toHaveLength(1);
    expect(r.runner.rollbackCheckpoint()).toBe(false);
  });
  it('expires protection after a successful next leg so a later failure cannot restore it', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    expect(r.runner.openDepot().buy('journal_checkpoint', null).ok).toBe(true);
    r.runner.continueTravel(); finish(r);
    r.runner.enter(createSyntheticLeg({ id: 'the_weave', index: 2 }), options); finish(r);
    const prior = r.notifications.filter(event => event.kind === 'debrief').at(-1);
    expect(prior?.kind === 'debrief' ? prior.view.dividend : 0).toBeGreaterThan(0);
    r.runner.enter(createSyntheticLeg({ id: 'quantum_pass', index: 3 }), options);
    tick(r); failConvoy(r);
    expect(r.runner.rollbackCheckpoint()).toBe(false);
    expect(r.runner.exit().survived).toBe(false);
    expect(r.store.get().decisions.some(record => record.kind === 'checkpoint_rollback')).toBe(false);
  });
  it('a later depot checkpoint restores the later boundary rather than the previous protected leg', () => {
    const r = rig(); r.runner.enter(travelLeg(), options);
    expect(r.runner.openDepot().buy('journal_checkpoint', null).ok).toBe(true);
    r.runner.continueTravel(); finish(r);
    r.runner.enter(createSyntheticLeg({ id: 'the_weave', index: 2 }), options); finish(r);
    r.runner.enter(createSyntheticLeg({ id: 'quantum_pass', index: 3 }), options);
    expect(r.runner.openDepot().buy('journal_checkpoint', null).ok).toBe(true);
    r.runner.continueTravel(); finish(r);
    r.runner.enter(createSyntheticLeg({ id: 'the_narrows', index: 4 }), options);
    const boundary = structuredClone(r.store.get()); const rng = saveRunStreams(r.streams);
    tick(r); tick(r); failConvoy(r); r.runner.exit();
    expect(r.runner.currentLeg?.id).toBe('the_narrows');
    expect(r.store.get().legIndex).toBe(4); expect(r.runner.kernel!.tick).toBe(0);
    expect(r.store.get().resources).toEqual(boundary.resources);
    expect(r.store.get().convoy).toEqual(boundary.convoy); expect(saveRunStreams(r.streams)).toEqual(rng);
    expect(r.store.get().decisions.filter(record => record.kind === 'checkpoint_rollback')).toMatchObject([{ legId: 'the_narrows', choice: 'the_narrows', outcome: 'costly' }]);
  });
  it('saves a kernel-free boundary with the exact stream state at both entry and exit', () => {
    const factory = vi.fn(createKernel);
    const guarded = rig(21, undefined, { createKernel: factory });
    guarded.runner.enter(travelLeg(), options);
    expect(factory.mock.calls[0]?.[1]).toMatchObject({ devBuild: true, checkInvariants: true });
    const entered = guarded.persist.mock.calls.at(-1);
    expect(entered?.[1]).toBe('boundary'); expect(entered?.[0].kernel).toBeNull();
    expect(entered?.[0].rngStates).toEqual(saveRunStreams(guarded.streams));
    expect(entered?.[0].run).toEqual(guarded.store.get());
    finish(guarded);
    const exited = guarded.persist.mock.calls.at(-1);
    expect(exited?.[1]).toBe('boundary'); expect(exited?.[0].kernel).toBeNull();
    expect(exited?.[0].rngStates).toEqual(saveRunStreams(guarded.streams));
    expect(exited?.[0].run).toEqual(guarded.store.get());
  });
});

describe('casualty observations with game tombstones', () => {
  async function observationFixture() {
    const { observeLeg } = await import('../../src/game/replay/runReplay');
    const { asPid } = await import('../../src/kernel/types');
    const state = initialRunState(91, 'shell', 'operator');
    const snapshot = createKernel(createSyntheticLeg({ config: { enabledSubsystems: ['process', 'scheduler'] } }).kernelConfig(state)).snapshot();
    const bindings = new Map<import('../../src/kernel/types').ConvoyMemberId, import('../../src/kernel/types').Pid>([
      ['lumen', asPid(2)], ['sable', asPid(3)], ['kestrel', asPid(4)], ['vesper', asPid(5)],
    ]);
    let seq = 0;
    const exited = (member: import('../../src/kernel/types').ConvoyMemberId, at: number, reason: import('../../src/kernel/types').TerminationReason): KernelEvent => {
      const pid = bindings.get(member);
      if (pid === undefined) throw new Error('missing casualty fixture binding');
      return { type: 'process.exited', seq: seq++, tick: asTick(at), pid, exitCode: reason === 'normal_exit' ? 0 : 137, reason };
    };
    const stone = (member: import('../../src/kernel/types').ConvoyMemberId, at: number, reason: import('../../src/kernel/types').TerminationReason): import('../../src/game/types').Epitaph => ({
      member, tick: asTick(at), reason, legId: 'fork_fields', inscription: 'Casualty fixture.', cause: 'Synthetic observation.', codexEntry: 'fixture.casualty',
    });
    return { observeLeg, snapshot, bindings, exited, stone, asPid };
  }

  it('retains legacy event-only observation and ignores normal or unbound exits', async () => {
    const f = await observationFixture();
    const events: KernelEvent[] = [
      f.exited('lumen', 5, 'normal_exit'), f.exited('sable', 7, 'starvation'),
      { type: 'process.exited', seq: 2, tick: asTick(8), pid: f.asPid(99), exitCode: 137, reason: 'out_of_memory' },
      { type: 'disk.seek', seq: 3, tick: asTick(8), from: 2, to: 13, distance: 11 },
    ];
    const before = structuredClone(events);
    const legacy = f.observeLeg(f.snapshot, events, f.bindings);
    expect(legacy.casualties).toEqual([{ member: 'sable', reason: 'starvation', tick: 7 }]);
    expect(legacy.storage.seekDistance).toBe(11);
    expect(f.observeLeg(f.snapshot, events, f.bindings, [])).toEqual(legacy);
    expect(events).toEqual(before);
  });

  it('pairs a command exit at N with its game epitaph at N+1 exactly once', async () => {
    const f = await observationFixture();
    const events = [f.exited('lumen', 10, 'killed_by_user')];
    const stones = [f.stone('lumen', 11, 'killed_by_user')];
    expect(f.observeLeg(f.snapshot, events, f.bindings, stones).casualties)
      .toEqual([{ member: 'lumen', reason: 'killed_by_user', tick: 11 }]);
    expect(f.observeLeg(f.snapshot, events, f.bindings).casualties)
      .toEqual([{ member: 'lumen', reason: 'killed_by_user', tick: 10 }]);
  });

  it('preserves repeated deaths and stable tick order while the game reason wins', async () => {
    const f = await observationFixture();
    const events = [f.exited('sable', 3, 'thrashing_collapse'), f.exited('lumen', 8, 'killed_by_user'),
      f.exited('lumen', 8, 'killed_by_user'), f.exited('kestrel', 9, 'out_of_memory')];
    const stones = [f.stone('lumen', 9, 'starvation'), f.stone('sable', 3, 'thrashing_collapse'),
      f.stone('lumen', 9, 'starvation'), f.stone('vesper', 9, 'io_timeout')];
    const before = structuredClone(stones);
    expect(f.observeLeg(f.snapshot, events, f.bindings, stones).casualties).toEqual([
      { member: 'sable', reason: 'thrashing_collapse', tick: 3 },
      { member: 'lumen', reason: 'starvation', tick: 9 },
      { member: 'lumen', reason: 'starvation', tick: 9 },
      { member: 'vesper', reason: 'io_timeout', tick: 9 },
      { member: 'kestrel', reason: 'out_of_memory', tick: 9 },
    ]);
    expect(stones).toEqual(before);
  });

  it('observes and replays game death after a terminal normal exit, without recounting entry tombstones', async () => {
    const { makeAffliction } = await import('../../src/game/afflictions/table');
    const { observeLeg } = await import('../../src/game/replay/runReplay');
    const seed = 91;
    const initial = initialRunState(seed, 'shell', 'operator');
    initial.convoy = initial.convoy.map(member => member.id === 'sable' ? { ...member, name: 'SABLE-2' } : member);
    initial.tombstones.push({ member: 'sable', tick: asTick(1), legId: 'fork_fields', reason: 'thrashing_collapse',
      inscription: 'Earlier attempt.', cause: 'Historical fixture.', codexEntry: 'fixture.old' });
    initial.convoy.find(member => member.id === 'lumen')!.afflictions.push(makeAffliction('starvation', asTick(-150)));
    const worker = new ReplayWorkerHandle();
    const requests = vi.spyOn(worker, 'run').mockResolvedValue({ ok: false, reason: 'timeout', message: 'Synthetic worker fallback.' });
    const r = rig(seed, initial, { replay: worker });
    const leg = createSyntheticLeg({ id: 'fork_fields', index: 1, processes: 0, service: [500, 501], config: { enabledSubsystems: ['process', 'scheduler'] } });
    try {
      r.runner.enter(leg, options);
      const entry = structuredClone(r.runner.replayEntry!);
      const pid = r.store.get().convoy.find(member => member.id === 'lumen')!.pid!;
      while (!r.runner.finished) {
        const kernel = r.runner.kernel!;
        if (kernel.tick === 5) {
          const outcome = r.bus.apply({ kind: 'syscall', request: { name: 'exit', pid, args: [0] } }, { source: 'terminal', legId: leg.id }, kernel.tick);
          expect(outcome.refused).toBeNull(); expect(outcome.syscall?.ok).toBe(true);
        }
        tick(r);
      }
      const kernel = r.runner.kernel!;
      const director = r.runner.director!;
      const events = [...director.allEvents];
      const currentStones = r.store.get().tombstones.slice(entry.run.tombstones.length);
      expect(currentStones).toMatchObject([{ member: 'lumen', reason: 'starvation', tick: 30 }]);
      expect(events.filter(event => event.type === 'process.exited' && event.pid === pid))
        .toMatchObject([{ type: 'process.exited', reason: 'normal_exit', tick: 5 }]);
      expect(observeLeg(kernel.snapshot(), events, director.bindings).casualties).toEqual([]);
      const expected = [{ member: 'lumen', reason: 'starvation', tick: 30 }];
      expect(observeLeg(kernel.snapshot(), events, director.bindings, currentStones).casualties).toEqual(expected);
      const request: ReplayRequest = { seed, discClass: 'shell', difficulty: 'operator', legs: [leg.id], decisions: [...r.store.get().decisions],
        overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry };
      r.runner.exit();
      const card = r.notifications.find(event => event.kind === 'debrief');
      if (card?.kind !== 'debrief') throw new Error('missing casualty debrief');
      await card.view.counterfactual;
      expect(requests).toHaveBeenCalledTimes(1);
      expect(requests.mock.calls[0]?.[0].overrides.scheduler).toBe('priority_aging');
      const replay = runReplay(request);
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      if (!replay.ok) throw new Error(replay.message);
      expect(replay.casualties).toEqual(expected);
      expect(replay.survivors).not.toContain('lumen'); expect(replay.survivors).toContain('sable');
      expect(replay.eventLogHash).toBe(hashEventLog(events));
    } finally { worker.dispose(); }
  });
});


describe('approved replay entry and terminal provenance regressions', () => {
  it.each([
    ['architect', 15, 1, 'boot_sector', 0],
    ['kernel_space', 25, 2, 'boot_sector', 0],
    ['architect', 15, 1, 'fork_fields', 1],
    ['kernel_space', 25, 2, 'fork_fields', 1],
  ] as const)('preserves %s terminal costs (%s cycles, %s bandwidth) through direct replay of %s', (tier, policyCost, terminalCost, legId, index) => {
    const seed = 71;
    const leg = createSyntheticLeg({ id: legId, index, service: [500, 501], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
    const r = rig(seed, initialRunState(seed, 'shell', tier));
    r.runner.enter(leg, options);
    const entry = structuredClone(r.runner.replayEntry!);
    const before = { ...r.store.get().resources };
    for (const source of ['terminal', 'terminal', 'hud'] as const) {
      const outcome = r.bus.apply({ kind: 'set_scheduler', to: 'rr', quantum: 8 }, { source, legId }, r.runner.kernel!.tick);
      expect(outcome.refused).toBeNull();
      r.runner.observeCommands([outcome]);
    }
    expect(r.store.get().resources.cycles).toBe(before.cycles - 3 * policyCost);
    expect(r.store.get().resources.bandwidth).toBe(before.bandwidth - 2 * terminalCost);
    expect(r.store.get().decisions.map(record => record.choice)).toEqual(['[terminal] rr q=8', '[terminal] rr q=8', 'rr q=8']);
    while (!r.runner.finished) tick(r);
    const ledgerBeforeEvaluate = { ...r.store.get().resources };
    const expectedHash = hashEventLog(r.runner.director!.allEvents);
    r.runner.exit();
    const replayLedgers: ResourceLedger[] = [];
    const replay = runReplay({ seed, discClass: 'shell', difficulty: tier, legs: [legId], decisions: r.store.get().decisions,
      overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry }, {
      legs: id => {
        const base = resolveHeadlessLeg(id);
        return { ...base, evaluate: ctx => { replayLedgers.push({ ...ctx.run.resources }); return base.evaluate(ctx); } };
      },
    });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(replayLedgers).toEqual([ledgerBeforeEvaluate]);
    if (replay.ok) {
      expect(replay.eventLogHash).toBe(expectedHash);
      expect(replay.score).toEqual(r.store.get().score);
      expect(replay.diagnostics.skippedDecisions).toBe(0);
      if (legId === 'boot_sector') expect(replay.ticks).toBe(0);
    }
  });

  it.each([['architect', 15, 1, 43], ['kernel_space', 25, 2, 17]] as const)
    ('preserves %s terminal provenance through provisional continuation', (tier, policyCost, terminalCost, writes) => {
      const seed = 72;
      const boot = createSyntheticLeg({ config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
      const leg = createSyntheticLeg({ id: 'fork_fields', index: 1, service: [500, 501], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
      const original = rig(seed, initialRunState(seed, 'shell', tier));
      original.runner.enter(boot, options); original.runner.exit(); original.runner.enter(leg, options);
      const startCycles = original.store.get().resources.cycles;
      for (let count = 0; count < writes; count++) {
        const outcome = original.bus.apply({ kind: 'set_scheduler', to: 'rr', quantum: 8 }, { source: 'terminal', legId: leg.id }, original.runner.kernel!.tick);
        expect(outcome.refused).toBeNull(); original.runner.observeCommands([outcome]);
      }
      expect(original.store.get().resources.cycles).toBe(startCycles - writes * policyCost);
      expect(original.store.get().resources.bandwidth).toBe(5);
      expect(original.store.get().decisions.filter(record => record.choice === '[terminal] rr q=8')).toHaveLength(writes);
      tick(original); tick(original);
      const def = { id: 'provenance-vault', legId: leg.id, lockId: 'vault', kind: 'mutex', ordered: true, anchor: 'vault', crosser: 'lumen' } as const;
      const refused = original.runner.resolveCrossing(def, 'monitor');
      expect(refused.refused).not.toBeNull(); expect(refused.attempts).toBe(0); expect(original.runner.kernel!.tick).toBe(2);
      tick(original);
      const saved = original.runner.saveProvisional();
      const director = original.runner.director!.snapshot();
      const restored = rig(seed, initialRunState(seed, 'shell', tier));
      expect(restored.runner.resume(saved, [boot, leg], options, (runner, current) => {
        if (current.id === leg.id) runner.registerCrossings([def]);
      }), JSON.stringify(restored.failure.mock.calls)).toBe(true);
      expect(restored.store.get()).toEqual(saved.run);
      expect(restored.runner.kernel!.snapshot()).toEqual(saved.kernel);
      expect(saveRunStreams(restored.streams)).toEqual(saved.rngStates);
      expect(restored.runner.director!.snapshot()).toEqual(director);
      for (const run of [original, restored]) {
        const before = { ...run.store.get().resources };
        const outcome = run.bus.apply({ kind: 'set_scheduler', to: 'rr', quantum: 8 }, { source: 'terminal', legId: leg.id }, run.runner.kernel!.tick);
        expect(outcome.refused).toBeNull(); run.runner.observeCommands([outcome]);
        expect(run.store.get().resources.cycles).toBe(before.cycles - policyCost);
        expect(run.store.get().resources.bandwidth).toBe(5 - terminalCost);
        tick(run);
      }
      expect(restored.store.get()).toEqual(original.store.get());
      expect(restored.runner.kernel!.snapshot()).toEqual(original.runner.kernel!.snapshot());
      expect(saveRunStreams(restored.streams)).toEqual(saveRunStreams(original.streams));
    });

  it('runs economic entry before config, populate and tick-zero admission for Boot and successive legs', () => {
    const seed = 73;
    const initial = initialRunState(seed, 'shell', 'operator');
    initial.resources.cycles = 90; initial.resources.bandwidth = 0;
    for (const member of initial.convoy) member.abilityCharges = 0;
    const specs = [['boot_sector', 0, 36], ['fork_fields', 1, 60], ['the_weave', 2, 36]] as const;
    const legs = specs.map(([id, index, bandwidth]) => ({
      ...createSyntheticLeg({ id, index, service: [500, 501], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } }),
      interactions: [{ id: 'exhaust-entry', label: 'Exercise resources', description: '', anchor: 'console', cost: { bandwidth }, enabledWhen: () => true }],
    }));
    // This fixture action makes each following entry demonstrate a reset, rather
    // than merely checking values which already happened to be at their cap.
    const registrations = legs.map(leg => {
      const r = rig(seed, initialRunState(seed, 'shell', 'operator'));
      r.runner.enter(leg, options);
      r.runner.registerInteraction('exhaust-entry', run => { for (const member of run.convoy) member.abilityCharges = 0; });
      return r;
    });
    const log: string[] = [];
    const entries: { leg: string; beforeBandwidth: number; beforeCharges: number[]; bandwidth: number; charges: number[]; pace: string }[] = [];
    const evaluated: { leg: string; ticks: number; bandwidth: number; charges: number[]; cycles: number }[] = [];
    const decisions: DecisionRecord[] = legs.flatMap(leg => [
      { legId: leg.id, tick: asTick(0), kind: 'set_rations', choice: 'standard', outcome: 'pending', relatedObjective: null },
      { legId: leg.id, tick: asTick(0), kind: 'interaction', choice: 'exhaust-entry @ console', outcome: 'pending', relatedObjective: null },
    ]);
    try {
      const replay = runReplay({ seed, discClass: 'shell', difficulty: 'operator', legs: legs.map(leg => leg.id), decisions,
        overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500,
        entry: { run: initial, rngStates: saveRunStreams(createRunStreams(seed)) } }, {
        legs: id => {
          const base = resolveHeadlessLeg(id); const hooks = base.hooks!;
          let prepared: Readonly<RunState> | null = null;
          return {
            ...base,
            kernelConfig: run => { log.push(`config:${id}`); expect(run.resources.bandwidth).toBe(prepared!.resources.bandwidth); return base.kernelConfig(run); },
            populate: ctx => { log.push(`populate:${id}`); expect(ctx.run.convoy.map(member => member.abilityCharges)).toEqual([2, 2, 3, 2, 2]); base.populate(ctx); },
            evaluate: ctx => {
              log.push(`evaluate:${id}`);
              evaluated.push({ leg: id, ticks: ctx.ticksElapsed, bandwidth: ctx.run.resources.bandwidth,
                charges: ctx.run.convoy.map(member => member.abilityCharges), cycles: ctx.run.resources.cycles });
              return base.evaluate(ctx);
            },
            hooks: {
              ...hooks,
              enter: (streams, store) => {
                log.push(`enter:${id}`);
                const beforeBandwidth = store.get().resources.bandwidth;
                const beforeCharges = store.get().convoy.map(member => member.abilityCharges);
                hooks.enter!(streams, store);
                prepared = store.get();
                entries.push({ leg: id, beforeBandwidth, beforeCharges, bandwidth: prepared.resources.bandwidth,
                  charges: prepared.convoy.map(member => member.abilityCharges), pace: prepared.policy.pace });
              },
              admit: (command, origin, at) => {
                log.push(`admit:${id}`); expect(at).toBe(0);
                expect(prepared!.resources.bandwidth).toBe(specs.find(spec => spec[0] === id)![2]);
                expect(prepared!.convoy.map(member => member.abilityCharges)).toEqual([2, 2, 3, 2, 2]);
                return hooks.admit!(command, origin, at);
              },
              dispatch: (record, kernel, streams, store) => {
                log.push(`dispatch:${id}`); return hooks.dispatch!(record, kernel, streams, store);
              },
            },
          };
        },
      });
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(log).toEqual(specs.flatMap(([id]) => [`enter:${id}`, `config:${id}`, `populate:${id}`, `admit:${id}`, `dispatch:${id}`, `evaluate:${id}`]));
      expect(entries).toEqual([
        { leg: 'boot_sector', beforeBandwidth: 0, beforeCharges: [0, 0, 0, 0, 0], bandwidth: 36, charges: [2, 2, 3, 2, 2], pace: 'steady' },
        { leg: 'fork_fields', beforeBandwidth: 0, beforeCharges: [0, 0, 0, 0, 0], bandwidth: 60, charges: [2, 2, 3, 2, 2], pace: 'conservative' },
        { leg: 'the_weave', beforeBandwidth: 0, beforeCharges: [0, 0, 0, 0, 0], bandwidth: 36, charges: [2, 2, 3, 2, 2], pace: 'conservative' },
      ]);
      expect(evaluated.map(row => [row.leg, row.ticks, row.bandwidth, row.charges])).toEqual([
        ['boot_sector', 0, 0, [0, 0, 0, 0, 0]], ['fork_fields', 100, 0, [0, 0, 0, 0, 0]], ['the_weave', 109, 0, [0, 0, 0, 0, 0]],
      ]);
      expect(evaluated[1]?.cycles).toBe(90);
      expect(evaluated[2]?.cycles).toBeGreaterThan(0);
      expect(evaluated[2]?.cycles).toBeLessThan(102.375);
      if (replay.ok) { expect(replay.ticks).toBe(209); expect(replay.diagnostics.skippedDecisions).toBe(0); }
    } finally {
      for (const r of registrations) r.runner.director?.dispose();
    }
  });
});


describe('replay boundary score parity', () => {
  it('gives the next leg the live full score after completions and outcome awards without double counting', () => {
    const seed = 82;
    const base = createSyntheticLeg({ id: 'fork_fields', index: 1, processes: 3, service: [1, 2], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
    const first: Leg = { ...base, evaluate: ctx => ({ ...base.evaluate(ctx),
      resourceDelta: { cycles: -200, quota: 17 }, objectivesMet: ['score.first', 'shared', 'shared'],
      codexUnlocked: ['score.codex', 'shared-codex', 'score.codex'],
    }) };
    const nextBase = createSyntheticLeg({ id: 'the_weave', index: 2, processes: 2, service: [1, 2], config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
    const seen: { score: RunState['score']; objectives: string[]; codex: string[] }[] = [];
    const second: Leg = { ...nextBase, kernelConfig: run => {
      seen.push({ score: { ...run.score }, objectives: [...run.objectivesMet], codex: [...run.codexUnlocked] });
      // An authored leg may legitimately choose its configuration from prior score.
      return { ...nextBase.kernelConfig(run), scheduler: run.score.throughput === 120 ? 'fcfs' : 'rr' };
    } };
    const r = rig(seed, initialRunState(seed, 'compiler', 'operator'));
    r.runner.enter(first, options);
    const entry = structuredClone(r.runner.replayEntry!);
    finish(r);
    const firstBoundary = { score: { ...r.store.get().score }, objectives: [...r.store.get().objectivesMet], codex: [...r.store.get().codexUnlocked] };
    expect(firstBoundary.score.throughput).toBe(120);
    expect(firstBoundary.score.conceptsMastered).toBe(360);
    expect(firstBoundary.objectives).toEqual(['score.first', 'shared']);
    expect(firstBoundary.codex).toEqual(['score.codex', 'shared-codex']);
    r.runner.enter(second, options); finish(r);
    const finalScore = { ...r.store.get().score };
    expect(finalScore.throughput).toBe(200);
    const replay = runReplay({ seed, discClass: 'compiler', difficulty: 'operator', legs: [first.id, second.id],
      decisions: r.store.get().decisions, overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 500, entry });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(seen).toEqual([firstBoundary, firstBoundary]);
    if (replay.ok) {
      expect(replay.score).toEqual(finalScore);
      expect(replay.score.throughput).toBe(200);
      expect(replay.diagnostics.legs[1]?.eventLogHash).toBe(hashEventLog(r.runner.director!.allEvents));
    }
  });
});

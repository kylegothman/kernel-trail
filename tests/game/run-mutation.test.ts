import { describe, expect, it } from 'vitest';
import { createKernel } from '../../src/kernel/Kernel';
import { asTick } from '../../src/kernel/types';
import { CommandBus, type KernelMutators } from '../../src/game/CommandBus';
import { LegRunner } from '../../src/game/LegRunner';
import { LegSandbox } from '../../src/game/LegSandbox';
import { RunDirector } from '../../src/game/RunDirector';
import { acquire } from '../../src/game/afflictions/AfflictionClock';
import type { EpitaphCopySource } from '../../src/game/convoy/derezz';
import { createRunStore } from '../../src/game/runStore';
import type { Store } from '../../src/game/store';
import type { Leg, RunState } from '../../src/game/types';
import { createHeadlessSetupContext, type ConvoyBindings } from '../../src/game/replay/headlessLegs';
import { applyLegOutcome, initialRunState } from '../../src/game/replay/runReplay';
import { createRunStreams } from '../../src/game/replay/types';
import { livePolicyBinding } from '../../src/game/travel/policyBinding';
import { createSyntheticLeg } from './fixtures/syntheticLeg';

/** Only get() is guarded: mutate receives the real root, which remains writable. */
function guardReads(actual: Store<RunState>) {
  let attempts = 0;
  let mutations = 0;
  const refuse = (): never => { attempts += 1; throw new Error('RunState write outside store.mutate'); };
  function protect<T extends object>(value: T): T {
    return new Proxy(value, {
      get(target, key, receiver): unknown {
        const child: unknown = Reflect.get(target, key, receiver);
        return typeof child === 'object' && child !== null ? protect(child) : child;
      },
      set: refuse, deleteProperty: refuse, defineProperty: refuse, setPrototypeOf: refuse, preventExtensions: refuse,
    });
  }
  const store: Store<RunState> = {
    get: () => protect(actual.get()),
    get version() { return actual.version; },
    mutate: recipe => { mutations += 1; actual.mutate(recipe); },
    watch: (select, on, eq) => actual.watch(select, on, eq),
    subscribe: on => actual.subscribe(on),
    flush: () => actual.flush(),
  };
  return { store, get attempts() { return attempts; }, get mutations() { return mutations; } };
}

const copy: EpitaphCopySource = {
  templates: reason => [{ id: `fixture.${reason}`, reason, inscription: '{NAME} completed the fixture.', cause: 'Synthetic integrity drain.', codexEntry: 'fixture.affliction' }],
};

describe('RunState mutation boundary', () => {
  it('the read proxy rejects nested writes while the store mutation draft stays writable', () => {
    const actual = createRunStore(initialRunState(1, 'shell', 'operator'));
    const guarded = guardReads(actual);
    expect(() => { guarded.store.get().resources.cycles = 0; }).toThrow('outside store.mutate');
    expect(() => { guarded.store.get().convoy.push(...actual.get().convoy); }).toThrow('outside store.mutate');
    const member = guarded.store.get().convoy[0];
    if (member === undefined) throw new Error('missing convoy fixture');
    expect(() => { member.integrity = 0; }).toThrow('outside store.mutate');
    guarded.store.mutate(run => { run.resources.cycles = 17; run.convoy[0]!.integrity = 92; });
    expect(actual.get().resources.cycles).toBe(17);
    expect(actual.get().convoy[0]?.integrity).toBe(92);
    expect(guarded.attempts).toBe(3);
  });

  it('a complete synthetic leg including commands, travel, events, afflictions, derezz and exit never writes through get()', () => {
    const actual = createRunStore(initialRunState(23, 'shell', 'operator'));
    const guarded = guardReads(actual);
    const store = guarded.store;
    const streams = createRunStreams(23);
    const leg: Leg = {
      ...createSyntheticLeg({ id: 'fork_fields', index: 1, processes: 2, service: [100, 101], config: { enabledSubsystems: ['process', 'scheduler'] } }),
      eventTable: [{ id: 'fixture.quota', weight: 100, title: 'Quota fixture', narration: 'Synthetic ledger event.', targets: null, inflicts: null, resourceDelta: { quota: 1 }, onlyIf: null }],
    };
    const kernel = createKernel(leg.kernelConfig(store.get()));
    const bindings: ConvoyBindings = new Map();
    leg.populate(createHeadlessSetupContext(kernel, store.get(), streams.leg.fork(leg.id), bindings));
    store.mutate(run => {
      for (const member of run.convoy) member.pid = bindings.get(member.id) ?? null;
      const sable = run.convoy.find(member => member.id === 'sable');
      if (sable === undefined) throw new Error('missing sentinel fixture');
      sable.integrity = 1;
      sable.status = 'critical';
      acquire(sable, 'bit_rot', asTick(0));
    });
    livePolicyBinding.apply(kernel, store.get().policy);
    const sandbox = new LegSandbox(leg, () => undefined);
    const director = new RunDirector({ leg, kernel, store, streams, bindings, sandbox, epitaphs: copy, maxTicks: 200 });
    const bus = new CommandBus({
      store, kernel, admit: (command, origin, at) => director.admit(command, origin, at),
      handlers: {
        useAbility: (member, target, at) => director.useAbility(member, target, at),
        interaction: (id, anchor, at) => { director.interaction(id, anchor, at); },
        terminal: (line, at) => director.terminal(line, at),
      },
    });
    try {
      expect(() => {
        for (let ticks = 0; !director.complete && ticks < 200; ticks += 1) {
          if (kernel.tick === 5) bus.dispatch({ kind: 'set_pace', to: 'aggressive' }, { source: 'hud', legId: leg.id });
          director.observeCommands(bus.drain(kernel.tick));
          director.preTick(kernel.tick);
          const events = kernel.step();
          director.postTick(kernel.tick, events);
        }
        const outcome = sandbox.evaluate({ run: store.get(), kernelSnapshot: kernel.snapshot(), events: director.allEvents, ticksElapsed: director.ticksElapsed });
        applyLegOutcome(store, outcome, leg.index);
      }).not.toThrow();
      expect(director.complete).toBe(true);
      expect(director.travel.segmentsDone).toBe(60);
      expect(director.travel.drawsFired).toBeGreaterThan(0);
      expect(store.get().legIndex).toBe(2);
      expect(store.get().legProgress).toBe(1);
      expect(store.get().tombstones.filter(stone => stone.member === 'sable')).toHaveLength(1);
      expect(store.get().decisions.some(decision => decision.kind === 'set_pace')).toBe(true);
      expect(guarded.mutations).toBeGreaterThan(kernel.tick);
      expect(guarded.attempts).toBe(0);
      expect(sandbox.failureList).toEqual([]);
    } finally { director.dispose(); }
  });

  it('the actual LegRunner enters, trades, reclaims, travels and exits through the guarded store', () => {
    const actual = createRunStore(initialRunState(31, 'shell', 'operator'));
    const guarded = guardReads(actual);
    const store = guarded.store;
    const streams = createRunStreams(31);
    const failures: string[] = [];
    const notifications: string[] = [];
    const saves: string[] = [];
    let completedTicks = 0;
    let runner: LegRunner;
    const currentKernel = () => {
      const kernel = runner.kernel;
      if (kernel === null) throw new Error('runner has no active kernel');
      return kernel;
    };
    const currentDirector = () => {
      const director = runner.director;
      if (director === null) throw new Error('runner has no active director');
      return director;
    };
    const kernel: KernelMutators = {
      setScheduler: (id, params) => currentKernel().setScheduler(id, params),
      setReplacementPolicy: id => currentKernel().setReplacementPolicy(id),
      setDiskPolicy: id => currentKernel().setDiskPolicy(id),
      setAllocationStrategy: id => currentKernel().setAllocationStrategy(id),
      setDeadlockStrategy: strategy => currentKernel().setDeadlockStrategy(strategy),
      syscall: request => currentKernel().syscall(request),
    };
    const bus = new CommandBus({ store, kernel, admit: (command, origin, at) => currentDirector().admit(command, origin, at), handlers: {
      useAbility: (member, target, at) => currentDirector().useAbility(member, target, at),
      interaction: (id, anchor, at) => { currentDirector().interaction(id, anchor, at); },
      terminal: (line, at) => currentDirector().terminal(line, at),
    } });
    runner = new LegRunner({
      runStore: store, commandBus: bus, createKernel, streams, replay: null, epitaphs: copy,
      onEvent: () => undefined, persist: (_input, kind) => saves.push(kind), buildId: 'mutation-fixture',
      savedAtIso: () => '2026-09-16T00:00:00.000Z', throughputTarget: () => .1,
      onLegEvent: event => notifications.push(event.kind), codexSignal: () => undefined, onDerezz: () => undefined,
      onFailure: failure => failures.push(failure.phase), onRunnerFailure: message => failures.push(message),
    });
    const leg: Leg = {
      ...createSyntheticLeg({ id: 'fork_fields', index: 1, processes: 2, service: [100, 101], config: { enabledSubsystems: ['process', 'scheduler'] } }),
      eventTable: [{ id: 'fixture.quota', weight: 100, title: 'Quota fixture', narration: 'Synthetic ledger event.', targets: null, inflicts: null, resourceDelta: { quota: 1 }, onlyIf: null }],
    };
    expect(() => {
      runner.enter(leg, { maxTicks: 200, stageContext: null });
      expect(runner.openDepot().buy('quota_lot', null).ok).toBe(true);
      runner.continueTravel();
      const layout = runner.openReclamation();
      const leaked = layout.leaked[0];
      if (leaked === undefined) throw new Error('reclamation fixture has no leak');
      runner.submitReclamation([{ atSeconds: 3, action: 'collect', blockId: leaked.id }]);
      runner.continueTravel();
      store.mutate(run => {
        const sable = run.convoy.find(member => member.id === 'sable');
        if (sable === undefined) throw new Error('missing sentinel fixture');
        sable.integrity = 1; sable.status = 'critical'; acquire(sable, 'bit_rot', asTick(0));
      });
      for (let steps = 0; !runner.finished && steps < 200; steps += 1) {
        const active = currentKernel();
        if (active.tick === 5) bus.dispatch({ kind: 'set_pace', to: 'aggressive' }, { source: 'hud', legId: leg.id });
        runner.observeCommands(bus.drain(active.tick));
        runner.preTick(active.tick);
        const events = active.step();
        runner.postTick(active.tick, events);
      }
      expect(runner.finished).toBe(true);
      completedTicks = currentKernel().tick;
      runner.exit();
    }).not.toThrow();
    expect(store.get().legIndex).toBe(2);
    expect(store.get().tombstones.filter(stone => stone.member === 'sable')).toHaveLength(1);
    expect(store.get().decisions.map(decision => decision.kind)).toEqual(expect.arrayContaining(['depot', 'reclamation', 'set_pace']));
    expect(notifications).toEqual(expect.arrayContaining(['depot_open', 'reclamation_open', 'debrief']));
    expect(saves.filter(kind => kind === 'boundary')).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(guarded.attempts).toBe(0);
    expect(guarded.mutations).toBeGreaterThan(completedTicks);
  });
});

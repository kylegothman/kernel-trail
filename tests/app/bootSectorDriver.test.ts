/**
 * WP-24 section 2: the Boot Sector driver and the allowance it turns off.
 * The first case is the runner's side: a zero-segment leg entered with a null
 * allowance runs past ZERO_SEGMENT_TICK_ALLOWANCE and ends on its leg_done
 * record and on nothing else, in front of a person as in a replay.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTick, createKernel } from '../../src/kernel/index';
import { CommandBus, type KernelMutators } from '../../src/game/CommandBus';
import { LegRunner } from '../../src/game/LegRunner';
import { ZERO_SEGMENT_TICK_ALLOWANCE } from '../../src/game/RunDirector';
import { createRunStore } from '../../src/game/runStore';
import { initialRunState } from '../../src/game/replay/runReplay';
import { createRunStreams } from '../../src/game/replay/types';
import type { EpitaphCopySource } from '../../src/game/convoy/derezz';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';

const copy: EpitaphCopySource = { templates: reason => [{ id: reason, reason, inscription: '{NAME} stopped.', cause: 'Synthetic fixture.', codexEntry: `test.${reason}` }] };

function rig(seed = 21) {
  const store = createRunStore(initialRunState(seed, 'shell', 'operator'));
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
  const failure = vi.fn();
  runner = new LegRunner({ runStore: store, commandBus: bus, createKernel, streams: createRunStreams(seed), onEvent: () => undefined, replay: null, epitaphs: copy,
    persist: () => undefined, buildId: 'wp24-test', savedAtIso: () => '2026-09-20T00:00:00.000Z', throughputTarget: () => 0.1,
    onLegEvent: () => undefined, codexSignal: vi.fn(), onDerezz: vi.fn(), onFailure: failure, onRunnerFailure: failure });
  const tick = (): void => {
    const k = runner.kernel!;
    runner.observeCommands(bus.drain(k.tick));
    runner.preTick(k.tick);
    if (runner.director!.tickLimitReached) return;
    runner.postTick(k.tick, k.step());
  };
  return { store, runner, tick, failure };
}

describe('the zero-segment allowance as an option', () => {
  it('null runs past the allowance and ends on the leg_done record alone; the omitted option is the constant', () => {
    const r = rig();
    r.runner.enter(createSyntheticLeg(), { maxTicks: 1000, stageContext: null, zeroSegmentAllowance: null });
    for (let i = 0; i < ZERO_SEGMENT_TICK_ALLOWANCE + 50; i++) r.tick();
    expect(r.runner.finished).toBe(false);
    expect(r.runner.ticksElapsed).toBe(ZERO_SEGMENT_TICK_ALLOWANCE + 50);
    expect(r.failure).not.toHaveBeenCalled();
    r.store.mutate(run => { run.decisions.push({ tick: asTick(r.runner.ticksElapsed), legId: 'boot_sector', kind: 'leg_done', choice: 'gate', outcome: 'pending', relatedObjective: null }); });
    expect(r.runner.finished).toBe(true);
    r.runner.exit();
    expect(r.store.get().decisions.filter(record => record.kind === 'leg_done').map(record => record.choice)).toEqual(['gate']);
    const omitted = rig();
    omitted.runner.enter(createSyntheticLeg(), { maxTicks: 1000, stageContext: null });
    for (let i = 0; i < ZERO_SEGMENT_TICK_ALLOWANCE + 5 && !omitted.runner.finished; i++) omitted.tick();
    expect(omitted.runner.ticksElapsed).toBe(ZERO_SEGMENT_TICK_ALLOWANCE);
  });
});

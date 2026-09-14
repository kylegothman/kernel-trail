import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createPeterson } from '@kernel/sync/peterson';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture(reordering: boolean, fenced = false) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const scenario = createPeterson(kernel, { reordering, fenced, depth: 2 });
  return { kernel, scenario };
}

const variants = [
  { name: 'SC', reordering: false, fenced: false },
  { name: 'weak', reordering: true, fenced: false },
  { name: 'fenced', reordering: true, fenced: true },
];

describe('Peterson instruction scenarios', () => {
  it.each([false, true])('the pure program has exactly six numbered entries, fenced=%s', fenced => {
    const { kernel, scenario } = fixture(false, fenced); const program = kernel.program(scenario.actors[0].pid);
    expect(program?.length).toBe(fenced ? 7 : 6);
    const before = kernel.syncSubsystem.saveState();
    const operations = Array.from({ length: program?.length ?? 0 }, (_, index) => program?.at(index));
    expect(operations.filter(value => value?.kind === 'sync' && value.operation.op === 'scenario')).toHaveLength(6);
    for (let index = 0; index < 1000; index++) program?.at(index);
    expect(kernel.syncSubsystem.saveState()).toEqual(before);
  });

  it.each(variants)('$name draws the zero, one and longest remainder once per iteration', ({ reordering, fenced }) => {
    const { kernel, scenario } = fixture(reordering, fenced); const sync = kernel.syncSubsystem;
    const actor = scenario.actors[0]; const instruction = { op: 'scenario', scenario: scenario.id, step: 5 } as const;
    expect(sync.rng.save().label).toBe('root/sync');
    const draw = vi.spyOn(sync.rng, 'int').mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(7);
    try {
      for (const ticks of [0, 1, 7]) {
        const before = draw.mock.calls.length;
        for (let attempt = 0; attempt < Math.max(1, ticks); attempt++) {
          expect(sync.execute(actor, instruction)).toEqual({ advance: attempt === Math.max(1, ticks) - 1, deferService: false, target: null });
          expect(draw).toHaveBeenCalledTimes(before + 1);
          expect(draw).toHaveBeenLastCalledWith(0, 8);
        }
        expect(sync.saveState().sync.payload.actors.find(row => row.actor.tid === actor.tid)?.remainingWork).toBeNull();
      }
    } finally { draw.mockRestore(); }
  });

  it.each(variants)('$name charges remainder work as service and restores its partial duration without redrawing', ({ reordering, fenced }) => {
    const a = fixture(reordering, fenced); const b = fixture(reordering, fenced); let captured = false;
    for (let tick = 0; tick < 500; tick++) {
      a.kernel.step(); b.kernel.step(); const saved = a.kernel.syncSubsystem.saveState().sync;
      const pending = saved.payload.actors.find(row => row.remainingWork !== null && row.remainingWork > 1);
      if (pending === undefined) continue;
      const actor = pending.actor; const thread = a.kernel.threads.table.get(actor.tid);
      if (thread === undefined) throw new Error('missing Peterson thread');
      const pc = thread.programCounter;
      const instruction = a.kernel.program(actor.pid)?.at(pc);
      expect(instruction).toEqual({ kind: 'sync', operation: { op: 'scenario', scenario: a.scenario.id, step: 5 } });
      // Perturb only the sync contribution; the staged host and root/sync stream remain equivalent.
      b.kernel.syncSubsystem.work(actor, 1);
      expect(b.kernel.syncSubsystem.saveState().sync).not.toEqual(saved);
      b.kernel.syncSubsystem.prepareRestore(structuredClone(saved))();
      expect(b.kernel.syncSubsystem.saveState().sync).toEqual(saved);
      expect(b.kernel.syncSubsystem.rng.save()).toEqual(a.kernel.syncSubsystem.rng.save());
      const cpu = a.kernel.process(actor.pid)?.totalCpuUsed ?? 0; const service = thread.serviceRemaining;
      let actorSpins = 0;
      for (let tick = 0; tick < 100 && thread.programCounter === pc; tick++) {
        const frame = [...a.kernel.step()]; expect(b.kernel.step()).toEqual(frame);
        actorSpins += frame.filter(event => event.type === 'sync.busy_wait' && event.pid === actor.pid).length;
      }
      expect(thread.programCounter).toBe(pc + 1);
      expect(service - thread.serviceRemaining).toBe(pending.remainingWork);
      expect((a.kernel.process(actor.pid)?.totalCpuUsed ?? 0) - cpu).toBe(pending.remainingWork);
      expect(actorSpins).toBe(0);
      expect(b.kernel.run(500)).toEqual(a.kernel.run(500));
      expect(b.kernel.syncSubsystem.saveState()).toEqual(a.kernel.syncSubsystem.saveState());
      expect(b.kernel.syncSubsystem.rng.save()).toEqual(a.kernel.syncSubsystem.rng.save());
      captured = true; break;
    }
    expect(captured).toBe(true);
  });

  it('SYNC-PETERSON-1: SC preserves exclusion at every tick and reports zero races over 10,000 ticks', () => {
    const { kernel, scenario } = fixture(false); const races: number[] = [];
    kernel.events.on('sync.race_detected', event => races.push(event.tick));
    for (let tick = 0; tick < 10_000; tick++) {
      kernel.step();
      const requirement = kernel.syncSubsystem.saveState().sync.payload.requirements.find(value => value.resource === scenario.requirement);
      expect(requirement?.criticalActors.length).toBeLessThanOrEqual(1);
      expect(requirement?.mutualExclusionViolations).toBe(0);
    }
    expect(races).toEqual([]);
    expect(kernel.syncSubsystem.scenario(scenario.id)).toMatchObject({ entries: [548, 549] });
  });

  it('SYNC-PETERSON-2: the unchanged reference seed exhibits reordered overlap and an application race', () => {
    const { kernel, scenario } = fixture(true); let firstOverlap: number | null = null; let firstRace: number | null = null;
    for (let tick = 0; tick < 10_000; tick++) {
      const frame = kernel.step();
      firstRace ??= frame.find(event => event.type === 'sync.race_detected')?.tick ?? null;
      if ((kernel.syncSubsystem.requirements.state(scenario.requirement)?.mutualExclusionViolations ?? 0) > 0) firstOverlap ??= kernel.tick;
    }
    const requirement = kernel.syncSubsystem.saveState().sync.payload.requirements.find(value => value.resource === scenario.requirement);
    expect(requirement?.mutualExclusionViolations).toBeGreaterThan(0);
    expect(firstOverlap).not.toBeNull(); expect(firstRace).not.toBeNull();
    expect(firstOverlap).toBeLessThan(10_000); expect(firstRace).toBeLessThan(10_000);
    expect({ firstOverlap, firstRace, violations: requirement?.mutualExclusionViolations }).toEqual({ firstOverlap: 275, firstRace: 275, violations: 31 });
    expect(kernel.syncSubsystem.scenario(scenario.id)).toMatchObject({ entries: [511, 500] });
  });

  it('SYNC-PETERSON-3: mfence preserves exclusion at every tick with reordering enabled', () => {
    const { kernel, scenario } = fixture(true, true); const races: number[] = [];
    kernel.events.on('sync.race_detected', event => races.push(event.tick));
    for (let tick = 0; tick < 10_000; tick++) {
      kernel.step();
      const requirement = kernel.syncSubsystem.saveState().sync.payload.requirements.find(value => value.resource === scenario.requirement);
      expect(requirement?.criticalActors.length).toBeLessThanOrEqual(1);
      expect(requirement?.mutualExclusionViolations).toBe(0);
    }
    expect(races).toEqual([]);
    expect(kernel.syncSubsystem.scenario(scenario.id)).toMatchObject({ entries: [462, 469] });
  });
});

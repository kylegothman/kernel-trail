import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createPeterson } from '@kernel/sync/peterson';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture(reordering: boolean, fenced = false) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const scenario = createPeterson(kernel, { reordering, fenced, depth: 2 });
  return { kernel, scenario };
}

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
  });

  it('SYNC-PETERSON-2: the unchanged reference seed exhibits reordered overlap and an application race', () => {
    const { kernel, scenario } = fixture(true); const events = kernel.run(10_000);
    const requirement = kernel.syncSubsystem.saveState().sync.payload.requirements.find(value => value.resource === scenario.requirement);
    expect(requirement?.mutualExclusionViolations).toBeGreaterThan(0);
    expect(events.some(event => event.type === 'sync.race_detected' && event.tick < 10_000)).toBe(true);
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
  });
});

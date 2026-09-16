import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/index';
import { framesPerProcess } from '@kernel/memory/rations';
import { PACE_TABLE, RATIONS_TABLE, quantumOverhead, quotaPerTick } from '@game/travel/paceRations';
import { paceSpawnTransform } from '@game/travel/workload';
import { livePolicyBinding } from '@game/travel/policyBinding';
import type { Pace, ProcessSpec } from '@game/types';
import { syntheticConfig } from '../fixtures/syntheticLeg';

describe('narrative pace and rations tables', () => {
  it('reproduces every numerical pace column and derives the overhead', () => {
    const values = Object.values(PACE_TABLE).map(p => [p.quantum, p.segmentsPerTick, p.cyclesPerSegment, p.quantumOverhead, p.effectiveCyclesPerSegment, p.workloadArrivalRate]);
    expect(values).toEqual([[16, .6, 1.4, 1.125, 1.575, .70], [8, 1, 2, 1.25, 2.5, 1], [4, 1.5, 3, 1.5, 4.5, 1.45], [2, 2.1, 4.4, 2, 8.8, 2]]);
    for (const row of Object.values(PACE_TABLE)) {
      expect(quantumOverhead(row.quantum)).toBe(row.quantumOverhead);
      expect(row.cyclesPerSegment * row.quantumOverhead).toBeCloseTo(row.effectiveCyclesPerSegment, 12);
    }
  });
  it('uses fractional game reservations and a separate kernel allocation table', () => {
    expect(Object.values(RATIONS_TABLE).map(r => [r.framesPerProgram, r.integrityCostPerTick, r.afflictionChancePerTick, r.afflictionOnRoll]))
      .toEqual([[4, 0, 0, null], [2.5, 0, 0, null], [1.5, .3, .04, 'cache_thrash'], [.8, 1, .06, 'thrashing']]);
    for (const [rations, quota] of [['generous', 4], ['standard', 2.5], ['lean', 1.5], ['starved', .8]] as const) {
      expect(quotaPerTick(rations, 5)).toBeCloseTo(quota, 12);
      expect(framesPerProcess(rations, 64, 5)).not.toBe(RATIONS_TABLE[rations].framesPerProgram);
    }
    expect(quotaPerTick('standard', 0)).toBe(0);
    expect(quotaPerTick('standard', 3)).toBe(1.5);
  });
  it.each([
    ['conservative', [0, 3, 6, 9, 11], [7, 11, 16, 20, 24, 29]],
    ['steady', [0, 2, 4, 6, 8], [5, 8, 11, 14, 17, 20]],
    ['aggressive', [0, 1, 3, 4, 6], [3, 6, 8, 10, 12, 14]],
    ['reckless', [0, 1, 2, 3, 4], [3, 4, 6, 7, 9, 10]],
  ] as const)('transforms every synthetic arrival at %s', (pace, convoy, workload) => {
    const base: ProcessSpec = { name: 'fixture', priority: 10, burst: 4, service: 20, pages: 3, arrival: 0 };
    const transform = paceSpawnTransform(pace as Pace);
    expect([0, 2, 4, 6, 8].map(arrival => transform({ ...base, arrival }).arrival)).toEqual(convoy);
    expect([5, 8, 11, 14, 17, 20].map(arrival => transform({ ...base, arrival }).arrival)).toEqual(workload);
    expect(base.arrival).toBe(0);
    expect(transform(base)).not.toBe(base);
  });
  it('writes the active scheduler quantum and preserves allocation scheme and scope', () => {
    const kernel = createKernel(syntheticConfig(34), { checkInvariants: true });
    kernel.setScheduler('priority_aging', { quantum: 8 });
    kernel.memorySubsystem.setFramePolicy('standard', 'proportional', 'global');
    livePolicyBinding.apply(kernel, { pace: 'reckless', rations: 'lean', degreeOfMultiprogramming: 2 });
    expect(kernel.invariantState().schedulerId).toBe('priority_aging');
    expect(kernel.invariantState().schedulerParams.quantum).toBe(2);
    expect(kernel.memorySubsystem.framePolicy).toEqual({ rations: 'lean', allocationScheme: 'proportional', replacementScope: 'global' });
    expect(kernel.memorySubsystem.pager.control.degreeOfMultiprogramming).toBe(2);
  });
  it('does not write the quantum again at entry when the config already has it', () => {
    const config = syntheticConfig(35);
    const kernel = createKernel({ ...config, schedulerParams: { ...config.schedulerParams, quantum: 8 } });
    const setScheduler = vi.spyOn(kernel, 'setScheduler');
    livePolicyBinding.apply(kernel, { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 8 });
    expect(setScheduler).not.toHaveBeenCalled();
    expect(kernel.invariantState().schedulerParams.quantum).toBe(8);
  });
});

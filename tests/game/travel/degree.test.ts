import { describe, expect, it } from 'vitest';
import { asTick, createKernel } from '@kernel/index';
import { DegreeController } from '@game/travel/degree';
import { syntheticConfig } from '../fixtures/syntheticLeg';

function fixture() {
  const kernel = createKernel(syntheticConfig(70), { checkInvariants: true });
  const pids = Array.from({ length: 6 }, (_, i) => kernel.spawn({ name: `work${i}`, arrival: 0, pages: 4, burst: 20, service: 200, priority: 10 }));
  kernel.step();
  return { kernel, pids };
}
describe('global degree control', () => {
  it('has one throughput peak and recurrent above-threshold faults at crowded degrees', () => {
    // Synthetic warning threshold, with all kernel timing defaults preserved.
    // Cold page loads can cross it below the knee too; measure repeated
    // crossings after warmup as well as the unique throughput maximum.
    const threshold = 100;
    const rows = [];
    for (let degree = 1; degree <= 8; degree++) {
      const kernel = createKernel(syntheticConfig(70, { totalFrames: 24, thrashingThreshold: threshold,
        enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'] }), { checkInvariants: true });
      const pids = Array.from({ length: 8 }, (_, i) => kernel.spawn({ name: `pressure${i}`,
        arrival: 0, pages: 8, burst: 100, service: 100, priority: 10,
        referenceString: Array.from({ length: 100 }, (_, index) => index % 8) }));
      const controller = new DegreeController(kernel, pids, 8);
      expect(controller.ceiling).toBe(8); controller.set(degree, asTick(0));
      let lateFaultRate = 0; let thrashing = 0; let maxDemand = 0;
      let maximumLateFaultRate = 0; let aboveThresholdTicks = 0; let aboveThresholdEvents = 0;
      kernel.events.onAny(event => {
        if (event.type === 'memory.thrashing') {
          thrashing++;
          if (event.faultRate > kernel.config.thrashingThreshold) aboveThresholdEvents++;
        }
      });
      for (let tick = 0; tick < 1000; tick++) {
        kernel.step();
        const input = kernel.memorySubsystem.pager.input();
        maxDemand = Math.max(maxDemand, [...input.workingSets.values()].reduce((sum, pages) => sum + pages, 0));
        if (tick >= 200) {
          const faultRate = kernel.invariantState().metrics.memory.faultRate;
          lateFaultRate += faultRate; maximumLateFaultRate = Math.max(maximumLateFaultRate, faultRate);
          if (faultRate > kernel.config.thrashingThreshold) aboveThresholdTicks++;
        }
      }
      rows.push({ degree, throughput: kernel.invariantState().metrics.scheduling.throughput,
        meanFaultRate: lateFaultRate / 800, thrashing, maxDemand, maximumLateFaultRate, aboveThresholdTicks, aboveThresholdEvents });
    }
    const peak = Math.max(...rows.map(row => row.throughput));
    const best = rows.filter(row => row.throughput === peak);
    expect(best).toHaveLength(1);
    const optimal = best[0]!;
    expect(optimal.degree).toBeGreaterThan(1); expect(optimal.degree).toBeLessThan(8);
    expect(rows[0]!.throughput).toBeLessThan(peak); expect(rows.at(-1)!.throughput).toBeLessThan(peak);
    expect(optimal.maxDemand).toBeLessThanOrEqual(24);
    for (const crowded of rows.filter(row => row.degree >= 4)) {
      expect(crowded.thrashing).toBeGreaterThan(optimal.thrashing);
      expect(crowded.maximumLateFaultRate).toBeGreaterThan(threshold);
      expect(crowded.aboveThresholdTicks).toBeGreaterThan(optimal.aboveThresholdTicks);
      expect(crowded.aboveThresholdEvents).toBeGreaterThan(0);
      expect(crowded.maxDemand).toBeGreaterThan(24);
      expect(crowded.meanFaultRate).toBeGreaterThan(optimal.meanFaultRate);
      expect(crowded.throughput).toBeLessThan(peak);
    }
  });
  it('uses the real configured ceiling and clamps requests without immediate admission on raise', () => {
    const { kernel, pids } = fixture();
    const control = new DegreeController(kernel, pids, 8);
    expect(control.ceiling).toBe(8);
    const change = control.set(-4, asTick(1));
    expect(change.from).toBe(8); expect(change.to).toBe(1);
    expect(change.suspended.length).toBeGreaterThan(0);
    expect(change.suspended.every(pid => kernel.invariantState().suspended(pid))).toBe(true);
    const raise = control.set(100, asTick(1));
    expect(raise.to).toBe(8); expect(raise.admitted).toEqual([]);
  });
  it('reports the actual previous degree when the shared policy binding changed it', () => {
    const { kernel, pids } = fixture();
    const controller = new DegreeController(kernel, pids, 8);
    kernel.setDegreeOfMultiprogramming(3);
    expect(controller.current).toBe(3);
    expect(controller.set(2, kernel.tick).from).toBe(3);
  });
  it('moves the same processes for the same state and request', () => {
    const first = fixture(); const second = fixture();
    expect(new DegreeController(first.kernel, first.pids, 8).set(2, asTick(1)))
      .toEqual(new DegreeController(second.kernel, second.pids, 8).set(2, asTick(1)));
  });
  it('reports global convoy movement separately and rejects convoy classification as workload', () => {
    const { kernel, pids } = fixture();
    const convoy = pids.slice(3); const workload = pids.slice(0, 3);
    expect(() => new DegreeController(kernel, pids, 8, convoy)).toThrow('convoy pid');
    const controller = new DegreeController(kernel, workload, 8, convoy);
    const result = controller.set(1, asTick(1));
    expect(result.groups.convoy.suspended.length).toBeGreaterThan(0);
    expect(result.suspended).toEqual(result.groups.workload.suspended);
    expect(result.groups.other.suspended).toEqual([]);
  });
  it('computes convoy frame availability from active workload working sets', () => {
    const { kernel, pids } = fixture();
    const controller = new DegreeController(kernel, pids, 8);
    for (let tick = 0; tick < 10; tick++) kernel.step();
    const view = kernel.invariantState();
    const demand = pids.filter(pid => !view.suspended(pid)).reduce((sum, pid) => sum + (view.metrics.memory.workingSets.get(pid) ?? 0), 0);
    expect(controller.framesAvailableToConvoy(64)).toBe(64 - demand);
    controller.set(1, kernel.tick);
    const after = kernel.invariantState();
    const activeDemand = pids.filter(pid => !after.suspended(pid)).reduce((sum, pid) => sum + (after.metrics.memory.workingSets.get(pid) ?? 0), 0);
    expect(controller.framesAvailableToConvoy(64)).toBe(64 - activeDemand);
  });
});

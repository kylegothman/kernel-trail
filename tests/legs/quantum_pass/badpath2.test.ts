/**
 * WP-L03's second known-bad path: reckless pace, quantum 2, never leave round
 * robin. The ribbon fills with switch gaps until the gaps are wider than the
 * work bands.
 *
 * One half of the package's assertion is not measurable against the shipped
 * engine and is recorded here rather than faked. `KernelTuning.contextSwitchTicks`
 * defaults to zero and is a kernel option rather than a `KernelConfig` field,
 * so a leg cannot charge for a switch and the simulator never loses a tick to
 * one. Utilisation therefore does not fall as the quantum shrinks; it stays at
 * one, and a smaller quantum buys real response time for free. The leg's
 * `SWITCH_COST` of one tick is the teaching figure the ribbon draws and the
 * objectives read, not a charge the kernel makes. What the quantum does change,
 * and what this file asserts, is the count of preemptions it forces.
 */
import { describe, expect, it } from 'vitest';
import { OVERHEAD_LIMIT, SWITCH_RATE_LIMIT } from '@legs/quantum_pass/evaluate';
import { OBJECTIVE_IDS } from '@legs/quantum_pass/objectives';
import { SWITCH_COST } from '@legs/quantum_pass/config';
import { shadowLeg } from '@legs/quantum_pass/replay';
import { runLeg } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';

const SEED = 0x4b54524c;
const leg = await loadLegForTest('quantum_pass');
const reckless = (): ReturnType<typeof makeRunState> => makeRunState({ seed: SEED, legIndex: 3, pace: 'reckless', ledger: { cycles: 1425 } });

const result = await runLeg(leg, {
  seed: SEED, run: reckless(),
  script: { legId: 'quantum_pass', label: 'reckless round robin', steps: [{ at: 0, command: { kind: 'set_scheduler', to: 'rr', quantum: 2 } }] },
});

const fine = shadowLeg({ run: reckless(), pace: 'reckless', ticks: result.ticks, policy: 'rr', quantum: 2, keepRecordedChanges: false });
const coarse = shadowLeg({ run: reckless(), pace: 'reckless', ticks: result.ticks, policy: 'rr', quantum: 8, keepRecordedChanges: false });
const meanResponse = (run: typeof fine): number => {
  const rows = run.perProcess.filter((row) => row.response !== null);
  return rows.length === 0 ? 0 : rows.reduce((total, row) => total + (row.response ?? 0), 0) / rows.length;
};

describe('reckless pace at quantum 2, never leaving round robin', () => {
  it('completes with no panic', () => {
    expect(result.panics).toEqual([]);
    expect(result.legFailures).toEqual([]);
    expect(result.ticks).toBe(34);
  });

  it('spends more than thirty percent of the pass on switching', () => {
    const switches = result.events.filter((event) => event.type === 'context.switch').length;
    const overhead = (switches * SWITCH_COST) / result.ticks;
    expect(overhead).toBeGreaterThan(0.3);
  });

  it('fails both the switch rate and the quantum sizing objectives', () => {
    expect(result.outcome.objectivesMet).not.toContain(OBJECTIVE_IDS.switchRate);
    expect(result.outcome.objectivesMet).not.toContain(OBJECTIVE_IDS.quantumSizing);
    // A quantum of 2 is below 1.2 times the sweep stream's median burst of 4, and it forces
    // preemptions at a rate well above both limits.
    expect(2).toBeLessThan(1.2 * 4);
    expect(SWITCH_RATE_LIMIT).toBeCloseTo(1 / 6, 9);
    expect(OVERHEAD_LIMIT).toBe(0.1);
  });

  it('the debrief blames the quantum against the median burst', () => {
    expect(result.outcome.debrief.whyItHappened).toBe("The quantum was 2 against the sweep stream's median burst of 4. Almost no burst finished inside a slice, so almost every slice ended in a save and a restore.");
  });

  it('a quantum of 2 forces preemptions that a quantum of 8 does not', () => {
    expect(fine.quantumExpiries).toBeGreaterThan(10);
    expect(coarse.quantumExpiries).toBe(0);
    expect(fine.contextSwitches).toBeGreaterThan(coarse.contextSwitches * 2);
  });

  it('records the trade the engine actually makes, which is not the one the package predicted', () => {
    // Response time improves rather than barely moving, and utilisation does not fall, because the
    // kernel charges nothing for a switch. Both readings are asserted so a later tuning that adds a
    // real switch charge fails here and the package's original claim can be restored.
    expect(meanResponse(fine)).toBeLessThan(meanResponse(coarse));
    expect(fine.metrics.cpuUtilisation).toBe(1);
    expect(coarse.metrics.cpuUtilisation).toBe(1);
  });

  it('nobody derezzes, because the pass ends before the fatal threshold at this pace', () => {
    // Ruling 7: the warning fires at every pace and the death needs a leg longer than the reckless one.
    expect(result.events.some((event) => event.type === 'process.starving')).toBe(true);
    expect(result.events.some((event) => event.type === 'process.starving' && event.fatal)).toBe(false);
    expect(result.outcome.casualties).toEqual([]);
  });
});

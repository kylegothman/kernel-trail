/**
 * WP-L03 acceptance 7 and 8: the death path, and the instructive wrong remedy
 * that does nothing.
 *
 * Under the entry configuration the pass runs a stream of higher-priority work
 * that never breaks, so SABLE is ready without ever being chosen. The kernel
 * warns her at `starvationThreshold` and derezzes her at
 * `starvationFatalThreshold`, and the stone quotes the number the wait counter
 * showed.
 */
import { describe, expect, it } from 'vitest';
import type { KernelEvent } from '@kernel/types';
import { content } from '@legs/quantum_pass/index';
import { STARVATION_FATAL_THRESHOLD, STARVATION_THRESHOLD } from '@legs/quantum_pass/config';
import { STARVATION_CAUSE } from '@legs/quantum_pass/copy';
import { shadowLeg } from '@legs/quantum_pass/replay';
import { ROSTER } from '@legs/quantum_pass/segments';
import type { DecisionScript } from '../harness/decisionScript';
import { runLeg, type HarnessResult } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { loadLegForTest } from '../harness/loadLeg';

/** Loaded through the registry so the companion is remembered and the director can dispatch an interaction. */
const leg = await loadLegForTest('quantum_pass');

const SEED = 0x4b54524c;
const SABLE_PID = 3;
const entering = (pace: 'conservative' | 'steady' | 'aggressive' | 'reckless' = 'steady'): ReturnType<typeof makeRunState> =>
  makeRunState({ seed: SEED, legIndex: 3, pace, ledger: { cycles: 1425 } });

const starving = (result: HarnessResult): readonly Extract<KernelEvent, { type: 'process.starving' }>[] =>
  result.events.filter((event): event is Extract<KernelEvent, { type: 'process.starving' }> => event.type === 'process.starving');

const passive = await runLeg(leg, { seed: SEED, run: entering() });

describe('the death path', () => {
  it('warns SABLE at the threshold and derezzes her at the fatal threshold (acceptance 7)', () => {
    const hers = starving(passive).filter((event) => event.pid === SABLE_PID);
    const warning = hers.find((event) => !event.fatal);
    const fatal = hers.find((event) => event.fatal);
    expect(warning?.waitedTicks).toBe(STARVATION_THRESHOLD);
    expect(fatal?.waitedTicks).toBe(STARVATION_FATAL_THRESHOLD);
    expect(fatal?.tick).toBe(STARVATION_FATAL_THRESHOLD + 1);
    const exit = passive.events.find((event) => event.type === 'process.exited' && event.pid === SABLE_PID);
    expect(exit?.type === 'process.exited' && exit.reason).toBe('starvation');
  });

  it('she is ready for the whole of it and never dispatched', () => {
    expect(passive.events.some((event) => event.type === 'context.switch' && event.to === SABLE_PID)).toBe(false);
    // One idle tick before she dies would be enough for a priority policy to dispatch her and reset
    // the counter, so the exclusion has to be unbroken up to that point. After it the pass may idle.
    const death = STARVATION_FATAL_THRESHOLD + 1;
    expect(passive.events.filter((event) => event.type === 'context.switch' && event.to === null && event.tick <= death)).toEqual([]);
  });

  it('warns no other convoy Program, so nobody merely queued acquires the affliction', () => {
    const convoyPids = ROSTER.map((_, index) => index + 2);
    const warned = new Set(starving(passive).map((event) => event.pid));
    for (const pid of convoyPids) {
      if (pid === SABLE_PID) continue;
      expect(warned.has(pid as never), `pid ${pid} was warned`).toBe(false);
    }
    // A derezzed Program keeps the affliction that killed it, so the living are what this asks about.
    expect(passive.run.convoy.filter((member) => member.status !== 'derezzed' && member.afflictions.some((affliction) => affliction.id === 'starvation')).map((member) => member.id)).toEqual([]);
  });

  it('the stone is hers, names the number the counter showed, and links the codex entry', () => {
    const stone = passive.run.tombstones.find((candidate) => candidate.legId === 'quantum_pass');
    expect(stone?.member).toBe('sable');
    expect(stone?.reason).toBe('starvation');
    expect(stone?.inscription).toBe('HERE LIES SABLE, READY SINCE TICK ONE');
    expect(stone?.cause).toBe(STARVATION_CAUSE);
    expect(stone?.cause).toContain(String(STARVATION_FATAL_THRESHOLD));
    expect(stone?.codexEntry).toBe('codex.priority_starvation');
  });

  it('ships an unpinned stone for the same reason, so a different Program has a candidate', () => {
    const forStarvation = content.epitaphs.filter((template) => template.reason === 'starvation');
    expect(forStarvation).toHaveLength(2);
    expect(forStarvation.filter((template) => template.member === undefined)).toHaveLength(1);
    expect(forStarvation.every((template) => template.legId === 'quantum_pass')).toBe(true);
  });

  it('the sentinel passive does not apply, because nothing sets convoyMemberId on a PCB', () => {
    // Sim spec 5.9 multiplies SABLE's thresholds by three, keyed on `ProcessControlBlock.convoyMemberId`.
    // The runner binds a Program to a pid in a side table and never writes that field, so the multiplier
    // is unreachable in a real run and the thresholds here are the ordinary ones. Filed as a follow-up.
    const warning = starving(passive).find((event) => event.pid === SABLE_PID && !event.fatal);
    expect(warning?.waitedTicks).toBe(STARVATION_THRESHOLD);
    expect(warning?.waitedTicks).not.toBe(STARVATION_THRESHOLD * 3);
  });
});

describe('the remedies', () => {
  const rescue = (steps: DecisionScript['steps']): Promise<HarnessResult> =>
    runLeg(leg, { seed: SEED, run: entering(), script: { legId: 'quantum_pass', label: 'rescue', steps } });

  it('priority aging within twenty ticks of the warning clears the affliction and saves her', async () => {
    const result = await rescue([{ when: { kind: 'event', type: 'process.starving' }, command: { kind: 'set_scheduler', to: 'priority_aging' } }]);
    expect(result.outcome.casualties).toEqual([]);
    expect(starving(result).some((event) => event.fatal)).toBe(false);
    // The event deck may have inflicted something else on her; what the remedy clears is the starvation.
    expect(result.run.convoy.find((member) => member.id === 'sable')?.afflictions.map((affliction) => affliction.id)).not.toContain('starvation');
    expect(result.events.some((event) => event.type === 'context.switch' && event.to === SABLE_PID)).toBe(true);
  });

  it('a nice gets her the processor, and leaves the affliction to finish her anyway', async () => {
    // Narrative 7.2's misleading remedy, working exactly as written. The syscall succeeds, the
    // scheduler dispatches her on the next tick, and the starvation affliction stays on her because
    // `isCuredBy` matches only the remedy the affliction names, which is the aging switch. She keeps
    // draining and she still goes. The bible says to accept nothing else as full credit, so the
    // objective does not either.
    const result = await rescue([
      { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'syscall', request: { name: 'nice', pid: SABLE_PID as never, args: [-5] } } },
    ]);
    const call = result.events.find((event) => event.type === 'syscall.invoked' && event.request.name === 'nice');
    expect(call?.type === 'syscall.invoked' && call.result.ok).toBe(true);
    expect(result.events.some((event) => event.type === 'context.switch' && event.to === SABLE_PID)).toBe(true);
    // No fatal starvation warning: the scheduler stopped excluding her. The affliction killed her instead.
    expect(starving(result).some((event) => event.fatal)).toBe(false);
    expect(result.run.convoy.find((member) => member.id === 'sable')?.afflictions.map((affliction) => affliction.id)).toContain('starvation');
    expect(result.outcome.casualties).toEqual(['sable']);
    expect(result.decisions.some((record) => record.kind === 'set_scheduler')).toBe(false);
  });

  it('only the aging switch meets the objective, because only it clears the affliction', async () => {
    const aged = await rescue([{ when: { kind: 'event', type: 'process.starving' }, command: { kind: 'set_scheduler', to: 'priority_aging' } }]);
    const niced = await rescue([{ when: { kind: 'event', type: 'process.starving' }, command: { kind: 'syscall', request: { name: 'nice', pid: SABLE_PID as never, args: [-5] } } }]);
    expect(aged.outcome.objectivesMet).toContain('obj.quantum_pass.clear_starvation');
    expect(niced.outcome.objectivesMet).not.toContain('obj.quantum_pass.clear_starvation');
  });
});

describe('the instructive wrong remedy', () => {
  it('raising the quantum under priority changes no scheduling decision (acceptance 8)', () => {
    const sequence = (quantum: number): string => shadowLeg({ run: entering(), pace: 'steady', ticks: passive.ticks, policy: 'priority', quantum, keepRecordedChanges: false })
      .events.filter((event) => event.type === 'context.switch')
      .map((event) => `${event.tick}:${String(event.type === 'context.switch' ? event.from : null)}->${String(event.type === 'context.switch' ? event.to : null)}`)
      .join(' ');
    const atTwo = sequence(2);
    expect(sequence(8), 'quantum 8 differs from quantum 2').toBe(atTwo);
    expect(sequence(32), 'quantum 32 differs from quantum 2').toBe(atTwo);
    expect(atTwo.length).toBeGreaterThan(0);
  });

  it('records the raise as pending, settles it costly once she dies, and never good', async () => {
    const result = await runLeg(leg, {
      seed: SEED, run: entering(),
      script: {
        legId: 'quantum_pass', label: 'wrong remedy',
        steps: [
          { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'interaction', id: 'pass.set_quantum', anchor: 'anchor.ledge_control' } },
          { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'set_scheduler', to: 'priority', quantum: 16 } },
          { when: { kind: 'progress_at_least', value: 0.6 }, command: { kind: 'interaction', id: 'pass.read_wait_counters', anchor: 'anchor.pass' } },
        ],
      },
    });
    const wrong = result.decisions.filter((record) => record.kind === 'raise_quantum_under_priority');
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.outcome).toBe('costly');
    expect(wrong.every((record) => record.outcome !== 'good')).toBe(true);
    const death = result.decisions.filter((record) => record.kind === 'starvation_unremedied');
    expect(death).toHaveLength(1);
    expect(death[0]?.outcome).toBe('fatal');
    expect(death[0]?.choice).toBe('sable');
    expect(result.outcome.casualties).toEqual(['sable']);
  });
});

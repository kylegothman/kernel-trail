/**
 * Each objective met and not met from constructed contexts, the survival
 * constant over 200 randomised sequences, and the counterfactual selection.
 */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createRng } from '@kernel/rng';
import { asPid, asTick, type KernelEvent, type KernelSnapshot } from '@kernel/types';
import type { Command } from '@game/CommandBus';
import type { DecisionRecord, LegEvaluationContext, RunState } from '@game/types';
import { bootSector } from './leg';
import { kernelConfig } from '@legs/boot_sector/config';
import { BATCHED_OVERHEAD, CASE_ONE_THRESHOLD, counterfactual, evaluate, FLOORS, judge, quantumPassSteadyCost } from '@legs/boot_sector/evaluate';
import { OBJECTIVE_IDS } from '@legs/boot_sector/objectives';
import { TRAP_COST, WINDOW_IDS } from '@legs/boot_sector/windows';
import type { ScriptStep } from '../harness/decisionScript';
import { assertClean, runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { CODEX } from './scripts';

let snapshot: KernelSnapshot | null = null;
function kernelSnapshot(): KernelSnapshot {
  snapshot ??= createKernel(kernelConfig(makeRunState({ seed: 1, legIndex: 0 }))).snapshot();
  return snapshot;
}

const record = (kind: string, choice: string, outcome: DecisionRecord['outcome'] = 'pending'): DecisionRecord =>
  ({ tick: asTick(0), legId: 'boot_sector', kind, choice, outcome, relatedObjective: null });
const interaction = (id: string, anchor: string, outcome: DecisionRecord['outcome'] = 'pending'): DecisionRecord => record('interaction', `${id} @ ${anchor}`, outcome);
const purchase = (window: string, items: readonly string[], mode = 'kernel', outcome: DecisionRecord['outcome'] = 'good'): DecisionRecord[] => [
  interaction('boot.set_mode', `anchor.win.${window}:${mode}`),
  ...items.map((item) => interaction('boot.batch_request', `anchor.win.${item}`)),
  interaction('boot.trap_purchase', `anchor.win.${window}`, outcome),
];
const syscallEvent = (ok: boolean, seq: number): KernelEvent => ({
  type: 'syscall.invoked', tick: asTick(0), seq, request: { name: 'getpid', pid: asPid(2), args: [] },
  result: ok ? { ok: true, value: 2 } : { ok: false, errno: 'EPERM', message: 'refused' },
});

/** A complete, well-played requisition: every service acquired in two batches, two manuals first, the right gate answer. */
function goodDecisions(): DecisionRecord[] {
  return [
    record('terminal', 'man EPERM'), record('terminal', 'man syscall'),
    ...purchase('quota', ['quota:40', 'blocks:40', 'bandwidth:50', 'manifest']),
    ...purchase('identity', ['identity', 'priority:1'], 'user'),
    interaction('boot.choose_disc', 'anchor.disc_plinth:blocks', 'good'),
  ];
}

function context(decisions: readonly DecisionRecord[], ledger: Partial<RunState['resources']> = {}, events: readonly KernelEvent[] = []): LegEvaluationContext {
  const run = makeRunState({ seed: 1, legIndex: 0, ledger: { cycles: 1184, quota: 940, blocks: 160, bandwidth: 86, ...ledger }, decisions });
  return { run, kernelSnapshot: kernelSnapshot(), events, ticksElapsed: 0 };
}

describe('boot_sector objectives', () => {
  it('meets all six on the well-played requisition', () => {
    const outcome = evaluate(context(goodDecisions()));
    expect(outcome.objectivesMet).toEqual(Object.values(OBJECTIVE_IDS));
    expect(outcome.survived).toBe(true);
    expect(outcome.casualties).toEqual([]);
    expect(outcome.resourceDelta).toEqual({});
    expect(outcome.codexUnlocked).toEqual(CODEX);
    expect(outcome.debrief.counterfactual).toBeNull();
    expect(outcome.debrief.headline).toBe('Outfitted.');
    expect(outcome.debrief.whatHappened).toContain('You raised 2 traps and paid 8 cycles');
    expect(outcome.debrief.whatHappened).toContain('1184 cycles, 940 quota, 160 blocks and 86 bandwidth');
  });

  it('acquire_via_trap needs every service acquired, no refused submission and no kernel EPERM', () => {
    const missingService = evaluate(context([...purchase('quota', ['quota:40', 'blocks:40', 'bandwidth:50', 'manifest']), ...purchase('identity', ['identity'], 'user')]));
    expect(missingService.objectivesMet).not.toContain(OBJECTIVE_IDS.acquireViaTrap);
    const refused = evaluate(context([...goodDecisions(), ...purchase('blocks', ['blocks:10'], 'user', 'costly')]));
    expect(refused.objectivesMet).not.toContain(OBJECTIVE_IDS.acquireViaTrap);
    const kernelEperm = evaluate(context(goodDecisions(), {}, [syscallEvent(true, 0), syscallEvent(false, 1)]));
    expect(kernelEperm.objectivesMet).not.toContain(OBJECTIVE_IDS.acquireViaTrap);
    expect(evaluate(context(goodDecisions(), {}, [syscallEvent(true, 0)])).objectivesMet).toContain(OBJECTIVE_IDS.acquireViaTrap);
  });

  it('mode_switch_budget needs overhead under 40 and all four floors', () => {
    const tenTraps = [...goodDecisions(), ...Array.from({ length: 8 }, () => purchase('identity', ['identity'], 'user')).flat()];
    expect(judge(context(tenTraps)).overhead).toBe(10 * TRAP_COST);
    expect(evaluate(context(tenTraps)).objectivesMet).not.toContain(OBJECTIVE_IDS.modeSwitchBudget);
    for (const key of ['cycles', 'quota', 'blocks', 'bandwidth'] as const) {
      expect(evaluate(context(goodDecisions(), { [key]: FLOORS[key] - 1 })).objectivesMet, key).not.toContain(OBJECTIVE_IDS.modeSwitchBudget);
      expect(evaluate(context(goodDecisions(), { [key]: FLOORS[key] })).objectivesMet, key).toContain(OBJECTIVE_IDS.modeSwitchBudget);
    }
  });

  it('classify_privilege counts the label at the first submission per service and allows one miss', () => {
    const oneMiss = [...purchase('quota', ['quota:40', 'blocks:40', 'bandwidth:50', 'manifest']), ...purchase('identity', ['identity'], 'kernel'), ...purchase('priority', ['priority:1'], 'user')];
    expect(evaluate(context(oneMiss)).objectivesMet).toContain(OBJECTIVE_IDS.classifyPrivilege);
    const twoMisses = [...purchase('quota', ['quota:40', 'blocks:40', 'bandwidth:50', 'manifest']), ...purchase('identity', ['identity', 'priority:1'], 'kernel')];
    expect(evaluate(context(twoMisses)).objectivesMet).not.toContain(OBJECTIVE_IDS.classifyPrivilege);
    // A later correction does not count: the first submission through the window labelled it.
    const corrected = [...purchase('quota', ['quota:40'], 'user', 'costly'), ...purchase('quota', ['quota:40'])];
    const state = judge(context(corrected)).state;
    expect(state.labels.quota).toBe('user');
    const neverSubmitted = evaluate(context([...purchase('quota', ['quota:40'])]));
    expect(neverSubmitted.objectivesMet).not.toContain(OBJECTIVE_IDS.classifyPrivilege);
  });

  it('balanced_ledger needs every category above zero', () => {
    for (const key of ['cycles', 'quota', 'blocks', 'bandwidth'] as const) {
      expect(evaluate(context(goodDecisions(), { [key]: 0 })).objectivesMet, key).not.toContain(OBJECTIVE_IDS.balancedLedger);
    }
    expect(evaluate(context(goodDecisions(), { cycles: 1 })).objectivesMet).toContain(OBJECTIVE_IDS.balancedLedger);
  });

  it('consult_manual needs two distinct topics before the first successful purchase', () => {
    const sameTopic = [record('terminal', 'man EPERM'), record('terminal', 'man EPERM'), ...purchase('quota', ['quota:40'])];
    expect(evaluate(context(sameTopic)).objectivesMet).not.toContain(OBJECTIVE_IDS.consultManual);
    const late = [record('terminal', 'man EPERM'), ...purchase('quota', ['quota:40']), record('terminal', 'man syscall')];
    expect(evaluate(context(late)).objectivesMet).not.toContain(OBJECTIVE_IDS.consultManual);
    const afterRefusal = [record('terminal', 'man EPERM'), ...purchase('quota', ['quota:40'], 'user', 'costly'), record('terminal', 'man syscall'), ...purchase('quota', ['quota:40'])];
    expect(evaluate(context(afterRefusal)).objectivesMet).toContain(OBJECTIVE_IDS.consultManual);
    expect(evaluate(context([record('terminal', '[terminal] man mode'), record('terminal', 'man EPERM')])).objectivesMet).toContain(OBJECTIVE_IDS.consultManual);
  });

  it('disc_class_tradeoff needs the class table answer for the run class', () => {
    expect(evaluate(context([interaction('boot.choose_disc', 'anchor.disc_plinth:cycles')])).objectivesMet).not.toContain(OBJECTIVE_IDS.discClassTradeoff);
    expect(evaluate(context([interaction('boot.choose_disc', 'anchor.disc_plinth:blocks')])).objectivesMet).toContain(OBJECTIVE_IDS.discClassTradeoff);
    expect(evaluate(context([])).objectivesMet).not.toContain(OBJECTIVE_IDS.discClassTradeoff);
    for (const [discClass, answer] of [['daemon', 'cycles'], ['compiler', 'cycles']] as const) {
      const run = makeRunState({ seed: 1, legIndex: 0, discClass, decisions: [interaction('boot.choose_disc', `anchor.disc_plinth:${answer}`)] });
      expect(evaluate({ run, kernelSnapshot: kernelSnapshot(), events: [], ticksElapsed: 0 }).objectivesMet, discClass).toContain(OBJECTIVE_IDS.discClassTradeoff);
      const wrong = makeRunState({ seed: 1, legIndex: 0, discClass, decisions: [interaction('boot.choose_disc', 'anchor.disc_plinth:blocks')] });
      expect(evaluate({ run: wrong, kernelSnapshot: kernelSnapshot(), events: [], ticksElapsed: 0 }).objectivesMet, discClass).not.toContain(OBJECTIVE_IDS.discClassTradeoff);
    }
  });

  it('throws on a context whose events are not the runner log', () => {
    expect(() => evaluate({ ...context([]), events: [{ type: 'syscall.invoked' }] })).toThrow(/asKernelEvents/);
  });
});

describe('boot_sector counterfactual', () => {
  it('case 1 when overhead exceeds 24, case 2 when quota is under its floor, null when every floor is cleared', () => {
    expect(CASE_ONE_THRESHOLD).toBe(24);
    expect(BATCHED_OVERHEAD).toBe(8);
    expect(counterfactual(BATCHED_OVERHEAD, 900)).toBeNull();
    expect(counterfactual(CASE_ONE_THRESHOLD, 900)).toBeNull();
    expect(counterfactual(BATCHED_OVERHEAD, FLOORS.quota)).toBeNull();
    expect(counterfactual(28, 900)).toBe(`The same purchases in two submissions would have cost 8 cycles of overhead instead of 28. That difference is 20 cycles, and the Quantum Pass costs ${quantumPassSteadyCost()} at steady pace.`);
    expect(quantumPassSteadyCost()).toBe(175);
    expect(counterfactual(BATCHED_OVERHEAD, 10)).toBe('You are carrying 10 quota. The Fork Fields needs enough to hold five address spaces plus the scouts you will create there.');
  });

  it('when both apply the larger shortfall wins and a tie goes to case 1', () => {
    expect(counterfactual(28, 0)).toMatch(/^You are carrying 0 quota/);
    expect(counterfactual(120, 20)).toMatch(/^The same purchases in two submissions/);
    expect(counterfactual(CASE_ONE_THRESHOLD + 4, FLOORS.quota - 4)).toMatch(/^The same purchases in two submissions/);
    expect(counterfactual(CASE_ONE_THRESHOLD + 4, FLOORS.quota - 5)).toMatch(/^You are carrying/);
  });
});

describe('boot_sector survival', () => {
  it('survived is true and casualties are empty across 200 randomised decision sequences, with no leg failure', async () => {
    const rng = createRng(0x4b54524c, 'boot_sector_random');
    const windows = [...WINDOW_IDS, 'nowhere'];
    const anchors = ['anchor.depot', 'anchor.plate', 'anchor.block_stack', 'anchor.cpu_pillar', 'anchor.disc_plinth'];
    const ids = bootSector.interactions.map((def) => def.id);
    for (let sequence = 0; sequence < 200; sequence++) {
      const steps: ScriptStep[] = [];
      const count = rng.int(0, 25);
      for (let i = 0; i < count; i++) {
        const roll = rng.next();
        let command: Command;
        if (roll < 0.6) {
          const id = rng.pick(ids);
          const window = rng.pick(windows);
          const argument = rng.next() < 0.5 ? String(rng.int(-1200, 1200)) : rng.pick(['kernel', 'user', 'blocks', 'cycles', 'x']);
          command = { kind: 'interaction', id, anchor: rng.next() < 0.3 ? rng.pick(anchors) : `anchor.win.${window}:${argument}` };
        } else if (roll < 0.8) {
          command = { kind: 'syscall', request: { name: rng.pick(['getpid', 'nice', 'brk', 'open', 'write', 'ioctl'] as const), pid: asPid(rng.int(2, 7)), args: [rng.int(-2, 40)] } };
        } else if (roll < 0.9) {
          command = { kind: 'terminal', line: rng.pick(['man EPERM', 'man syscall', 'help', 'mode --history']) };
        } else {
          command = { kind: 'set_pace', to: rng.pick(['conservative', 'steady', 'aggressive', 'reckless'] as const) };
        }
        steps.push({ at: 0, command });
      }
      const result = await runLeg(bootSector, { seed: sequence + 1, script: { legId: 'boot_sector', label: `random ${sequence}`, steps } });
      assertClean(result);
      expect(result.outcome.survived, `sequence ${sequence}`).toBe(true);
      expect(result.outcome.casualties, `sequence ${sequence}`).toEqual([]);
      expect(result.run.convoy.every((member) => member.status !== 'derezzed'), `sequence ${sequence}`).toBe(true);
      for (const value of Object.values(result.ledgerAfter)) expect(value, `sequence ${sequence}`).toBeGreaterThanOrEqual(0);
    }
  });
});

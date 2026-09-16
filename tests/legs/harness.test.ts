/**
 * The harness's own suite, WP-20 "Tests you must write", run against the
 * composite synthetic leg of scope correction W8. No real leg exists today,
 * so every real-leg case in the other suites skips; this file is what proves
 * the harness.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { asTick, createKernel } from '@kernel/index';
import { originFromRecord } from '@game/CommandBus';
import { runReplay } from '@game/replay/runReplay';
import { LEG_ORDER, type Leg, type LegId } from '@game/types';
import { stripComments } from '../kernel/sourceScan';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';
import {
  assertClean, assertHeadless, remainderHashAfter, runLeg, type HarnessResult,
} from './harness/LegHarness';
import { assertLegShape, loadLegForTest, loadShippedSet, REPO_ROOT, scanForbiddenImports, tryLoadLegForTest } from './harness/loadLeg';
import { makeConvoy, makeRunState } from './harness/makeRunState';
import { validateScript, type DecisionScript } from './harness/decisionScript';
import { CompetentPolicy, competentCrossingChoice, ScriptedDecisions, type DriverContext } from './harness/scriptedDecisions';
import { expectOutcome, outcomeProblems } from './harness/expectOutcome';
import { REQUIRED_EVENTS } from './harness/requiredEvents';
import {
  createHarnessLeg, FIXTURE_SEED, HARNESS_CROSSING, HARNESS_LEG_ID, HARNESS_OBJECTIVE_IDS,
  KNOWN_BAD_EXPECTATION, KNOWN_BAD_SCRIPT, KNOWN_GOOD_EXPECTATION, KNOWN_GOOD_SCRIPT,
} from './harness/syntheticLeg';

const HARNESS_DIR = resolve(REPO_ROOT, 'tests', 'legs', 'harness');
const script = (steps: DecisionScript['steps'], patch: Partial<DecisionScript> = {}): DecisionScript => ({ legId: HARNESS_LEG_ID, label: 'case', crossings: [HARNESS_CROSSING], steps, ...patch });

async function firstUnshipped(): Promise<LegId | null> {
  for (const id of LEG_ORDER) {
    const result = await tryLoadLegForTest(id);
    if (!result.shipped) return id;
  }
  return null;
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|mts|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out.sort();
}

describe('loading', () => {
  it('constructs by id: every shipped leg loads and an unshipped id throws with its id in the message', async () => {
    const shipped = await loadShippedSet();
    for (const leg of shipped.legs) expect((await loadLegForTest(leg.id)).id).toBe(leg.id);
    const missing = await firstUnshipped();
    if (missing === null) console.log('harness: every leg has shipped; the unshipped-id half of this case has nothing to exercise');
    else await expect(loadLegForTest(missing)).rejects.toThrow(missing);
    const synthetic = await loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: async () => ({ default: createHarnessLeg() }) });
    expect(synthetic.id).toBe(HARNESS_LEG_ID);
    expect(synthetic.index).toBe(LEG_ORDER.indexOf(HARNESS_LEG_ID));
  });

  it('try load: an unshipped id returns shipped false with the missing path', async () => {
    const missing = await firstUnshipped();
    if (missing === null) { console.log('harness: every leg has shipped; try load has no unshipped id to exercise'); return; }
    const result = await tryLoadLegForTest(missing);
    expect(result.shipped).toBe(false);
    if (!result.shipped) expect(result.reason).toContain(`src/legs/${missing}/index.ts does not exist`);
  });

  it('asserts the shape on load, naming the field', async () => {
    const wrongIndex = { ...createHarnessLeg(), index: 3 };
    await expect(loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: async () => ({ default: wrongIndex }) })).rejects.toThrow(/index/);
    const wrongId = { ...createHarnessLeg(), id: 'the_weave' as LegId };
    expect(() => assertLegShape(wrongId, HARNESS_LEG_ID)).toThrow(/id/);
    const noEvaluate = { ...createHarnessLeg(), evaluate: undefined as unknown as Leg['evaluate'] };
    expect(() => assertLegShape(noEvaluate, HARNESS_LEG_ID)).toThrow(/evaluate/);
  });

  it('a present index whose import is rejected throws with the id rather than reading as unshipped', async () => {
    await expect(loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: () => Promise.reject(new Error('syntax error')) })).rejects.toThrow(/fork_fields.*syntax error/);
  });

  it('forbidden import: a synthetic leg importing three fails at load with a message naming the import', async () => {
    const forbidden = join(HARNESS_DIR, 'forbidden', 'index.ts');
    expect(existsSync(forbidden)).toBe(true);
    await expect(tryLoadLegForTest(HARNESS_LEG_ID, { indexPath: forbidden, loader: () => import('./harness/forbidden/index') })).rejects.toThrow(/imports three at module scope/);
    expect(scanForbiddenImports("import type { Vector3 } from 'three';\n// import { Mesh } from 'three'\nconst x = 1;")).toEqual([]);
    expect(scanForbiddenImports("import {\n  Mesh,\n} from 'three/webgpu';")).toEqual(['three/webgpu']);
    expect(scanForbiddenImports("export * from '@world/index';\nimport '@audio';\nimport { a } from '../../render/x';")).toEqual(['@world/index', '@audio', '../../render/x']);
    expect(scanForbiddenImports("import { LEG_ORDER } from '@game/types';\nimport { asPid } from '@kernel/types';")).toEqual([]);
  });
});

describe('the run loop', () => {
  it('no dom: document and window are undefined during a run, and the harness refuses to run otherwise', async () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(() => assertHeadless()).not.toThrow();
    const result = await runLeg(createHarnessLeg(), { seed: 1, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    Reflect.set(globalThis, 'document', {});
    try {
      await expect(runLeg(createHarnessLeg(), { seed: 1 })).rejects.toThrow(/node environment/);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('no stage: createStage is not called when stageContext is null', async () => {
    const onStage = vi.fn();
    const result = await runLeg(createHarnessLeg({ onStage }), { seed: 3, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    expect(onStage).not.toHaveBeenCalled();
    expect(result.stageCalls).toBe(0);
  });

  it('repeatable: two runs in one process give the same hash, outcome and run state', async () => {
    const first = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    const second = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    assertClean(first);
    expect(second.logHash).toBe(first.logHash);
    expect(second.outcome).toEqual(first.outcome);
    expect(second.run).toEqual(first.run);
    expect(second.ticks).toBe(first.ticks);
    expect(first.events.length).toBeGreaterThan(0);
  });

  it('restore mid-leg: the remainder and the whole log hash identically to the uninterrupted run', async () => {
    const straight = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    const restored = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT, restoreAt: Math.floor(straight.ticks / 2) });
    assertClean(restored);
    expect(restored.restore).not.toBeNull();
    if (restored.restore === null) throw new Error('unreachable');
    expect(restored.restore.at).toBeGreaterThanOrEqual(Math.floor(straight.ticks / 2));
    expect(restored.restore.remainderHash).toBe(remainderHashAfter(straight, restored.restore.seq));
    expect(restored.logHash).toBe(straight.logHash);
    expect(restored.outcome).toEqual(straight.outcome);
    expect(restored.run).toEqual(straight.run);
    expect(restored.ticks).toBe(straight.ticks);
  });

  it('panic fails: a leg that panics stops the run, lands in panics, and fails a clean assertion', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 4, script: script([{ at: 3, command: { kind: 'set_replacement', to: 'optimal' } }]) });
    expect(result.panics).toHaveLength(1);
    expect(result.panics[0]).toMatch(/OPT requires a scripted workload/);
    expect(result.ticks).toBeLessThan(10);
    expect(() => assertClean(result)).toThrow(/panics/);
  });

  it('sandbox reported: a leg that throws in evaluate lands in legFailures and fails a clean assertion', async () => {
    const leg: Leg = { ...createHarnessLeg(), evaluate: () => { throw new Error('bad evaluator'); } };
    const result = await runLeg(leg, { seed: 5, script: KNOWN_GOOD_SCRIPT });
    expect(result.legFailures.map((failure) => failure.phase)).toEqual(['evaluate']);
    expect(result.outcome.debrief.headline).toContain('reduced instrumentation');
    expect(() => assertClean(result)).toThrow(/leg failures: evaluate: bad evaluator/);
  });

  it('a runner failure (the maxTicks cap) lands in runnerFailures, separate from leg failures', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 6, maxTicks: 12 });
    expect(result.runnerFailures).toHaveLength(1);
    expect(result.runnerFailures[0]).toMatch(/maxTicks/);
    expect(result.legFailures).toEqual([]);
    expect(result.ticks).toBe(12);
    expect(() => assertClean(result)).toThrow(/runner failures/);
  });

  it('measures wall time and the per-kernel-tick cost', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 7, script: KNOWN_GOOD_SCRIPT });
    expect(result.wallMs).toBeGreaterThan(0);
    expect(result.maxTickMs).toBeGreaterThan(0);
    expect(result.maxTickMs).toBeLessThan(result.wallMs);
  });
});

describe('scripts', () => {
  it('script at tick: a step at tick 40 lands in the tick-40 command drain', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 8, script: script([{ at: 40, command: { kind: 'set_pace', to: 'aggressive' } }]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record?.tick).toBe(40);
    expect(record?.choice).toBe('aggressive');
    expect(originFromRecord(record ?? result.decisions[0]!).source).toBe('replay');
    expect(result.unfiredSteps).toEqual([]);
  });

  it('script when: a trigger fires once, on the tick after it became true', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 9, script: script([{ when: { kind: 'event', type: 'context.switch', nth: 2 }, command: { kind: 'set_rations', to: 'lean' } }]) });
    assertClean(result);
    const switches = result.events.filter((event) => event.type === 'context.switch');
    expect(switches.length).toBeGreaterThanOrEqual(2);
    const records = result.decisions.filter((decision) => decision.kind === 'set_rations');
    expect(records).toHaveLength(1);
    expect(records[0]?.tick).toBe(switches[1]?.tick);
    expect(result.decisions.filter((decision) => decision.tick < (switches[1]?.tick ?? 0))).toEqual([]);
    expect(result.unfiredSteps).toEqual([]);
  });

  it('script order: three steps at the same tick fire in declared order', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 10, script: script([
      { at: 10, command: { kind: 'set_degree', to: 3 } },
      { at: 10, command: { kind: 'set_rations', to: 'generous' } },
      { at: 10, command: { kind: 'set_pace', to: 'conservative' } },
    ]) });
    assertClean(result);
    expect(result.decisions.filter((decision) => decision.tick === 10).map((decision) => decision.kind)).toEqual(['set_degree', 'set_rations', 'set_pace']);
  });

  it('unfired reported: a trigger that never becomes true leaves its step in unfiredSteps', async () => {
    const never = { when: { kind: 'resource_below', resource: 'cycles', value: -1 }, command: { kind: 'set_pace', to: 'reckless' } } as const;
    const result = await runLeg(createHarnessLeg(), { seed: 11, script: script([{ at: 2, command: { kind: 'set_pace', to: 'steady' } }, never]) });
    assertClean(result);
    expect(result.unfiredSteps).toEqual([never]);
    expect(result.decisions.some((decision) => decision.choice === 'reckless')).toBe(false);
  });

  it('a step whose tick was passed inside an action fires at the next slot and is noted', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 12, script: script([
      { at: 6, crossing: 'vault_gate', option: 'wait' },
      { at: 8, command: { kind: 'set_pace', to: 'aggressive' } },
    ]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record?.tick).toBeGreaterThan(8);
    expect(result.notes.some((note) => /tick 8 was passed inside an action/.test(note))).toBe(true);
    expect(result.unfiredSteps).toEqual([]);
  });

  it('validate script: the four failure kinds are named and a valid script returns empty', () => {
    expect(validateScript(KNOWN_GOOD_SCRIPT)).toEqual([]);
    expect(validateScript(KNOWN_BAD_SCRIPT)).toEqual([]);
    const negative = validateScript(script([{ at: -1, command: { kind: 'set_pace', to: 'steady' } }]));
    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatch(/not a non-negative integer/);
    const contradiction = validateScript(script([{ at: 4, command: { kind: 'set_pace', to: 'steady' } }, { at: 4, command: { kind: 'set_pace', to: 'reckless' } }]));
    expect(contradiction).toHaveLength(1);
    expect(contradiction[0]).toMatch(/contradicts an earlier set_pace at tick 4/);
    const undeclared = validateScript(script([{ at: 4, crossing: 'no_such_gate', option: 'spin' }]));
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatch(/crossing no_such_gate is not declared/);
    const noDepot = validateScript({ legId: 'drowned_reach', label: 'reach', steps: [{ at: 4, depot: 'repair', target: 'lumen' }] });
    expect(noDepot).toHaveLength(1);
    expect(noDepot[0]).toMatch(/drowned_reach has no depot/);
  });

  it('replay origin: every scripted command carries source replay, and the recorded decisions replay without the script', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    const commands = result.decisions.filter((decision) => ['set_pace', 'set_rations', 'interaction'].includes(decision.kind));
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const record of commands) expect(originFromRecord(record).source).toBe('replay');
    for (const kind of ['crossing_open', 'crossing', 'depot_open', 'depot', 'reclamation_open', 'reclamation', 'travel_resume']) {
      expect(result.decisions.some((decision) => decision.kind === kind), kind).toBe(true);
    }
    if (result.entry === null) throw new Error('missing entry');
    const replay = runReplay({ seed: FIXTURE_SEED, discClass: 'shell', difficulty: 'operator', legs: [HARNESS_LEG_ID], decisions: result.run.decisions,
      overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 2000, entry: result.entry });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (!replay.ok) return;
    expect(replay.eventLogHash).toBe(result.logHash);
    expect(replay.diagnostics.skippedDecisions).toBe(0);
  });
});

describe('policies', () => {
  it('passive dispatches nothing', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 13, policy: 'passive' });
    assertClean(result);
    expect(result.decisions).toEqual([]);
    expect(result.ticks).toBeGreaterThan(50);
  });

  it('competent applies the remedy for an acquired affliction and notes the remedies it cannot issue', async () => {
    const gusts: Leg = { ...createHarnessLeg(), eventTable: [
      { id: 'gust', weight: 60, title: 'Gust', narration: 'cache gust', targets: null, inflicts: 'cache_thrash', resourceDelta: {}, onlyIf: null },
      { id: 'orphan', weight: 40, title: 'Orphan', narration: 'orphaned', targets: null, inflicts: 'orphaned', resourceDelta: {}, onlyIf: null },
    ] };
    const result = await runLeg(gusts, { seed: 14, policy: 'competent' });
    assertClean(result);
    const remedies = result.decisions.filter((decision) => decision.kind === 'set_scheduler');
    expect(remedies.length).toBeGreaterThan(0);
    expect(remedies[0]?.choice).toBe('rr q=16');
    expect(result.notes.some((note) => /remedy for orphaned .* not issuable headlessly/.test(note))).toBe(true);
  });

  it('competent lowers the degree by one on memory.thrashing, never below one, and picks the cheapest viable crossing', () => {
    const dispatched: string[] = [];
    const fakeContext = (degree: number): DriverContext => ({
      legId: HARNESS_LEG_ID, tick: 5,
      kernel: { memorySubsystem: { pager: { control: { maximumDegree: 8 } } } } as unknown as DriverContext['kernel'],
      run: { ...makeRunState({ seed: 1, legIndex: 1, degree }) },
      dispatch: (command) => { dispatched.push(`${command.kind}:${'to' in command ? String(command.to) : ''}`); },
      flushCommands: () => undefined,
      crossing: () => { throw new Error('unused'); }, depot: () => { throw new Error('unused'); }, reclamation: () => { throw new Error('unused'); },
      note: () => undefined,
    });
    const thrashing = { type: 'memory.thrashing', tick: asTick(5), seq: 1, faultRate: 999, severity: 'critical' } as const;
    new CompetentPolicy().afterTick(fakeContext(3), [thrashing]);
    expect(dispatched).toEqual(['set_degree:2']);
    dispatched.length = 0;
    new CompetentPolicy().afterTick(fakeContext(1), [thrashing]);
    expect(dispatched).toEqual([]);
    expect(competentCrossingChoice({ contention: 0.2, ordered: true, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('spin');
    expect(competentCrossingChoice({ contention: 0.8, ordered: true, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('block');
    expect(competentCrossingChoice({ contention: 0.8, ordered: false, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('monitor');
  });

  it('chaotic rotates the dials every 40 ticks from its own stream and never picks optimal on an unscripted workload', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 4, policy: 'chaotic', maxTicks: 400 });
    expect(result.panics).toEqual([]);
    const paces = result.decisions.filter((decision) => decision.kind === 'set_pace');
    expect(paces.length).toBeGreaterThanOrEqual(1);
    expect(paces.every((decision) => decision.tick % 40 === 0)).toBe(true);
    expect(result.decisions.filter((decision) => decision.kind === 'set_replacement').every((decision) => decision.choice !== 'optimal')).toBe(true);
    const again = await runLeg(createHarnessLeg(), { seed: 4, policy: 'chaotic', maxTicks: 400 });
    expect(again.logHash).toBe(result.logHash);
  });

  it('a scheduled crossing in a policy run takes the policy option', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 15, policy: 'competent', crossings: [{ at: 12, def: HARNESS_CROSSING }] });
    assertClean(result);
    expect(result.crossings).toHaveLength(1);
    expect(result.crossings[0]?.option).toBe('spin');
    expect(result.decisions.some((decision) => decision.kind === 'crossing')).toBe(true);
  });

  it('competent is generic: the policy module imports nothing from a leg directory', () => {
    const source = stripComments(readFileSync(join(HARNESS_DIR, 'scriptedDecisions.ts'), 'utf8'), false);
    const legDirs = new RegExp(`from\\s*['"][^'"]*(?:legs/(?:${LEG_ORDER.join('|')})/|/fixtures)`, 'm');
    expect(source).not.toMatch(legDirs);
    expect(source).not.toMatch(/knownGood|knownBad/);
    expect(source).toMatch(/class CompetentPolicy/);
  });
});

describe('expectations', () => {
  let good: HarnessResult;
  const load = async (): Promise<HarnessResult> => (good ??= await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT }));

  it('the composite fixtures meet their own expectations', async () => {
    const result = await load();
    assertClean(result);
    expect(outcomeProblems(result, KNOWN_GOOD_EXPECTATION)).toEqual([]);
    expect(result.outcome.objectivesMet).toEqual(HARNESS_OBJECTIVE_IDS);
    const bad = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_BAD_SCRIPT });
    assertClean(bad);
    expect(outcomeProblems(bad, KNOWN_BAD_EXPECTATION)).toEqual([]);
    expect(bad.run.tombstones.map((stone) => `${stone.member}:${stone.reason}`)).toEqual(['lumen:starvation']);
  });

  it('expect subset: omitted expectation fields are not checked', async () => {
    const result = await load();
    expect(() => expectOutcome(result, {})).not.toThrow();
    expect(() => expectOutcome(result, { survived: true })).not.toThrow();
    expect(() => expectOutcome(result, { objectivesAtLeast: ['synthetic.survive'] })).not.toThrow();
    expect(() => expectOutcome(result, { ticksBetween: [result.ticks, result.ticks] })).not.toThrow();
    expect(() => expectOutcome(result, { casualtyCount: 0, decisionOutcomes: [{ kind: 'crossing', outcome: 'good' }] })).not.toThrow();
  });

  it('expect diff message: a set mismatch reports both directions and names the leg, seed, ticks and hash', async () => {
    const result = await load();
    let message = '';
    try {
      expectOutcome(result, { objectivesMet: ['synthetic.survive', 'synthetic.other'] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`[${HARNESS_LEG_ID} seed=${FIXTURE_SEED} ticks=${result.ticks} hash=${result.logHash}]`);
    expect(message).toContain('missing (expected, not present) [synthetic.other]');
    expect(message).toContain('unexpected (present, not expected) [synthetic.cross]');
  });

  it('absent events: a run in which a forbidden type fired fails', async () => {
    const result = await load();
    expect(result.eventTypes.has('context.switch')).toBe(true);
    expect(() => expectOutcome(result, { eventTypesAbsent: ['context.switch'] })).toThrow(/eventTypesAbsent: fired \[context.switch\]/);
    expect(() => expectOutcome(result, { eventTypesAbsent: ['deadlock.detected'] })).not.toThrow();
    expect(() => expectOutcome(result, { eventTypesPresent: ['deadlock.detected'] })).toThrow(/never fired/);
  });

  it('debrief.chapter compares chapter and sections and ignores the title', async () => {
    const result = await load();
    expect(() => expectOutcome(result, { debrief: { chapter: { chapter: 5, sections: [] } } })).not.toThrow();
    expect(() => expectOutcome(result, { debrief: { chapter: { chapter: 6, sections: [] } } })).toThrow(/expected chapter 6/);
  });
});

describe('run state and tables', () => {
  it('makeRunState builds a real RunState with the documented defaults', () => {
    const run = makeRunState({ seed: 21, legIndex: 4 });
    expect(Object.keys(run).sort()).toEqual(['codexUnlocked', 'convoy', 'decisions', 'difficulty', 'discClass', 'legIndex', 'legProgress', 'objectivesMet', 'policy', 'resources', 'runId', 'score', 'seed', 'status', 'tombstones']);
    expect(run.discClass).toBe('shell');
    expect(run.difficulty).toBe('operator');
    expect(run.policy).toEqual({ pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 6 });
    expect(run.resources).toEqual({ cycles: 1600, quota: 900, blocks: 120, bandwidth: 60 });
    expect(run.legIndex).toBe(4);
    expect(makeConvoy().map((member) => `${member.name}:${member.integrity}:${member.afflictions.length}`)).toEqual(['LUMEN:100:0', 'SABLE:100:0', 'ORRERY:100:0', 'KESTREL:100:0', 'VESPER:100:0']);
    const patched = makeRunState({ seed: 21, legIndex: 2, discClass: 'compiler', difficulty: 'architect', pace: 'reckless', ledger: { cycles: 12 }, convoy: [{ id: 'sable', integrity: 40 }] });
    expect(patched.resources).toEqual({ cycles: 12, quota: 336, blocks: 72, bandwidth: 24 });
    expect(patched.policy.pace).toBe('reckless');
    expect(patched.convoy.find((member) => member.id === 'sable')?.integrity).toBe(40);
    expect(() => makeRunState({ seed: 1, legIndex: 0, convoy: [{ id: 'nobody' as never }] })).toThrow(/no convoy member/);
  });

  it('REQUIRED_EVENTS ships all fourteen rows, keyed by LEG_ORDER, none empty', () => {
    expect(Object.keys(REQUIRED_EVENTS).sort()).toEqual([...LEG_ORDER].sort());
    for (const id of LEG_ORDER) expect(REQUIRED_EVENTS[id].length, id).toBeGreaterThan(0);
    expect(REQUIRED_EVENTS.the_cistern).toEqual(['sync.blocked', 'sync.released']);
  });

  it('the script driver evaluates state triggers from the live run', async () => {
    const driver = new ScriptedDecisions(script([{ when: { kind: 'progress_at_least', value: 0.5 }, command: { kind: 'set_pace', to: 'aggressive' } }]));
    expect(driver.unfired()).toHaveLength(1);
    const result = await runLeg(createHarnessLeg(), { seed: 16, script: script([{ when: { kind: 'progress_at_least', value: 0.5 }, command: { kind: 'set_pace', to: 'aggressive' } }]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record).toBeDefined();
    expect(record?.tick).toBeGreaterThanOrEqual(30);
    expect(result.unfiredSteps).toEqual([]);
  });
});

describe('boundaries', () => {
  it('nothing under src/ imports tests/legs/harness or tools', () => {
    const files = collect(resolve(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), false);
      code.split('\n').forEach((line, i) => {
        if (/\b(?:from|import)\s*\(?\s*['"][^'"]*(?:^|\/)(?:tests|tools)\//.test(line)) offences.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
      });
    }
    expect(offences).toEqual([]);
  });

  it('a synthetic leg from the WP-18 fixture still runs headlessly through the harness', async () => {
    const result = await runLeg(createSyntheticLeg({ id: 'the_weave', index: 2 }), { seed: 17 });
    assertClean(result);
    expect(result.legId).toBe('the_weave');
    expect(result.ticks).toBeGreaterThan(0);
    expect(createKernel(createSyntheticLeg().kernelConfig(result.run)).tick).toBe(0);
  });
});

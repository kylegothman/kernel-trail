/**
 * WP-21: the leg content seam. `validateContent` and its six problem kinds,
 * `layoutStage`, the runner's `enter` configure parameter and `applyContent`,
 * the terminal's identical re-registration and audit hook, the two codex
 * unlock arms, `asKernelEvents`, and the scan that keeps `src/legs` free of
 * the render layers. The composite synthetic leg of the harness and its
 * companion are the fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { asPid, asTick, type KernelEvent } from '@kernel/index';
import type { CodexEntry, CodexUnlock } from '@game/codexTypes';
import { createRunStore } from '@game/runStore';
import type { Leg } from '@game/types';
import { LEG_DEFERRED_COMMANDS, probeRunState, recordDeclarations, validateContent, type LegContent } from '@legs/content';
import { asKernelEvents } from '@legs/events';
import { layoutStage, type LegLayout } from '@legs/layout';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import { DEFERRED_COMMANDS, firstDefinitionDifference, ok, type CommandResult } from '@terminal/registry';
import { Codex } from '@ui/codex/Codex';
import { CodexRegistry } from '@ui/codex/entries';
import { isCommandOccurrence, matchesUnlock, structureFor } from '@ui/codex/triggers';
import { stripComments } from '../kernel/sourceScan';
import { curriculumDefinitions, makeFixture } from '../terminal/harness';
import { HarnessSession } from './harness/LegHarness';
import { REPO_ROOT, scanForbiddenImports } from './harness/loadLeg';
import { makeRunState } from './harness/makeRunState';
import { createHarnessLeg, HARNESS_CONTENT, HARNESS_CROSSING, HARNESS_INTERACTIONS } from './harness/syntheticLeg';

const noop = (): void => undefined;
const withContent = (patch: Partial<LegContent>): LegContent => ({ ...HARNESS_CONTENT, ...patch });
const withLayout = (patch: Partial<LegLayout>): LegContent => withContent({ layout: { ...HARNESS_CONTENT.layout, ...patch } });

/** The wave A command names of WP-21 acceptance 5, every one shipped by WP-15 and re-shipped by a leg. */
const WAVE_A_COMMANDS = ['man', 'syscall', 'mode', 'sched', 'nice', 'gantt', 'lock', 'race', 'trace', 'free', 'pagetable', 'tlb', 'frag'] as const;

function codexEntry(id: string, unlock: CodexUnlock): CodexEntry {
  return {
    id, title: id, chapter: { chapter: 5, sections: ['5.3.3'], title: 'CPU Scheduling' }, concept: `Concept of ${id}.`, unlock,
    workedExample: null, counterfactual: null, remedy: null, remedyVisibility: 'immediate', related: [], commands: [], epitaphs: [],
  };
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

describe('validateContent', () => {
  it('returns empty for the composite synthetic leg and its companion (acceptance 2)', () => {
    expect(validateContent(createHarnessLeg(), HARNESS_CONTENT)).toEqual([]);
  });

  it('records what populate declares against a probe run, never a kernel', () => {
    const leg = createHarnessLeg();
    const declared = recordDeclarations(leg);
    expect(declared.error).toBeNull();
    expect([...declared.sync]).toEqual(['vault']);
    expect([...declared.resources]).toEqual(['printer']);
    expect([...declared.bound].sort()).toEqual(['kestrel', 'lumen', 'orrery', 'sable', 'vesper']);
    expect(probeRunState(leg).legIndex).toBe(leg.index);
    expect(probeRunState(leg).convoy.map((member) => member.name)).toEqual(['LUMEN', 'SABLE', 'ORRERY', 'KESTREL', 'VESPER']);
    const throwing: Leg = { ...leg, populate: () => { throw new Error('no such resource'); } };
    expect(recordDeclarations(throwing).error).toBe('no such resource');
    expect(validateContent(throwing, HARNESS_CONTENT)).toEqual([
      expect.stringMatching(/populate threw against the recording context: no such resource/),
      expect.stringMatching(/crossing vault_gate: lockId vault is never declared/),
    ]);
  });

  it('names each of the six problem kinds on a failing fixture (acceptance 2)', () => {
    const leg = createHarnessLeg();
    const problems = (content: LegContent): readonly string[] => validateContent(leg, content);
    // 1. legId
    expect(problems(withContent({ legId: 'the_weave' }))).toEqual([expect.stringMatching(/^legId: the content is for the_weave, the leg is fork_fields$/)]);
    // 2. a crossing whose legId differs or whose lock is never declared
    expect(problems(withContent({ crossings: [{ ...HARNESS_CROSSING, legId: 'the_weave' }] }))).toEqual([expect.stringMatching(/^crossing vault_gate: legId the_weave is not fork_fields$/)]);
    expect(problems(withContent({ crossings: [{ ...HARNESS_CROSSING, lockId: 'no_such_lock' }] }))).toEqual([expect.stringMatching(/^crossing vault_gate: lockId no_such_lock is never declared by populate; declareSync ids \[vault\]$/)]);
    // 3. an interaction the leg does not declare, a declared one with no entry, or an integrity cost with no target
    expect(problems(withContent({ interactions: { ...HARNESS_CONTENT.interactions, ghost: { run: noop, target: null } } }))).toEqual([expect.stringMatching(/^interaction ghost: the leg declares no InteractionDef with that id$/)]);
    const { gate_overclock: _dropped, ...withoutGate } = HARNESS_CONTENT.interactions;
    expect(problems(withContent({ interactions: withoutGate }))).toEqual([
      expect.stringMatching(/^interaction gate_overclock: the companion registers no handler, so the director refuses it as unavailable$/),
      expect.stringMatching(/^interaction gate_overclock: costs 90 integrity and names no target Program$/),
    ]);
    expect(problems(withContent({ interactions: { ...HARNESS_CONTENT.interactions, gate_overclock: { run: noop, target: null } } }))).toEqual([expect.stringMatching(/^interaction gate_overclock: costs 90 integrity and names no target Program$/)]);
    // 4. a codex entry whose unlock names an undeclared objective
    expect(problems(withContent({ codex: [codexEntry('codex.fx', { kind: 'objective', id: 'synthetic.nope' })] }))).toEqual([expect.stringMatching(/^codex codex.fx: unlock names objective synthetic.nope, which the leg does not declare$/)]);
    expect(problems(withContent({ codex: [codexEntry('codex.fx', { kind: 'objective', id: 'synthetic.survive' }), codexEntry('codex.fy', { kind: 'event', type: 'process.starving' })] }))).toEqual([]);
    // 5. a terminal handler for a name that is not deferred
    expect(problems(withContent({ terminalHandlers: { ps: () => ok([]) } }))).toEqual([expect.stringMatching(/^terminal handler ps: not a deferred command \[hyper, guest, migrate, belady\]; every other handler is WP-15's$/)]);
    expect(problems(withContent({ terminalHandlers: { hyper: () => ok([]) } }))).toEqual([]);
    // 6. a layout whose anchors are not the interaction anchors plus extras
    expect(problems(withLayout({ anchors: HARNESS_CONTENT.layout.anchors.slice(0, 2), cameraTargets: ['vault'] }))).toEqual([expect.stringMatching(/^layout: anchors must be the interaction anchors plus extras; missing \[gate\]; unexpected \[\]$/)]);
    const spire = { id: 'spire', kind: 'custom', position: [0, 4, 0], structure: 'Spire' } as const;
    expect(problems(withLayout({ anchors: [...HARNESS_CONTENT.layout.anchors, spire] }))).toEqual([expect.stringMatching(/missing \[\]; unexpected \[spire\]$/)]);
    expect(problems(withLayout({ anchors: [...HARNESS_CONTENT.layout.anchors, spire], extras: ['spire'] }))).toEqual([]);
    const { structure: _named, ...unnamed } = spire;
    expect(problems(withLayout({ anchors: [...HARNESS_CONTENT.layout.anchors, unnamed], extras: ['spire'] }))).toEqual([expect.stringMatching(/^layout: custom anchor spire names no structure$/)]);
    expect(problems(withLayout({ anchors: [...HARNESS_CONTENT.layout.anchors, HARNESS_CONTENT.layout.anchors[0]!] }))).toEqual([expect.stringMatching(/^layout: duplicate anchor ids \[vault\]$/)]);
    expect(problems(withLayout({ cameraTargets: ['vault', 'nowhere'] }))).toEqual([expect.stringMatching(/^layout: camera targets \[nowhere\] are not anchor ids$/)]);
  });

  it('LEG_DEFERRED_COMMANDS mirrors the terminal registry exactly (pre-flight ruling 2)', () => {
    expect([...LEG_DEFERRED_COMMANDS]).toEqual([...DEFERRED_COMMANDS]);
  });
});

describe('layoutStage', () => {
  it('resolves every declared anchor to its LayoutAnchor, null otherwise, and update and dispose do nothing (acceptance 3)', () => {
    const stage = layoutStage(HARNESS_CONTENT.layout);
    for (const anchor of HARNESS_CONTENT.layout.anchors) expect(stage.anchor(anchor.id)).toBe(anchor);
    expect(stage.anchor('nowhere')).toBeNull();
    expect(stage.anchor('')).toBeNull();
    expect(stage.update(0.016, 0.5)).toBeUndefined();
    expect(stage.dispose()).toBeUndefined();
    expect(stage.anchor('vault')).toBe(HARNESS_CONTENT.layout.anchors[0]);
    const empty = layoutStage({ anchors: [], cameraTargets: [], extras: [] });
    expect(empty.anchor('vault')).toBeNull();
    const created = createHarnessLeg().createStage({ quality: 'low', run: makeRunState({ seed: 1, legIndex: 1 }) });
    for (const def of HARNESS_INTERACTIONS) expect(created.anchor(def.anchor)).toBe(HARNESS_CONTENT.layout.anchors.find((anchor) => anchor.id === def.anchor));
  });
});

describe('LegRunner.enter and applyContent', () => {
  it('calls configure after the director exists and before the first tick, and applyContent registers every crossing and interaction (acceptance 4)', () => {
    const leg = createHarnessLeg();
    const session = new HarnessSession(3, makeRunState({ seed: 3, legIndex: 1 }), 0.1);
    const order: string[] = [];
    session.runner.onKernelChanged((kernel) => { order.push(kernel === null ? 'kernel:none' : `kernel:${kernel.tick}`); });
    session.runner.enter(leg, { maxTicks: 50, stageContext: null }, (runner, entered) => {
      order.push('configure');
      expect(runner).toBe(session.runner);
      expect(entered).toBe(leg);
      expect(runner.director).not.toBeNull();
      expect(runner.kernel?.tick).toBe(0);
      expect(runner.phase).toBe('travelling');
      const director = runner.director!;
      const crossings = vi.spyOn(runner, 'registerCrossings');
      const interactions = vi.spyOn(runner, 'registerInteraction');
      const directorCrossings = vi.spyOn(director, 'registerCrossings');
      const directorInteractions = vi.spyOn(director, 'registerInteraction');
      runner.applyContent(HARNESS_CONTENT);
      expect(crossings).toHaveBeenCalledTimes(1);
      expect(crossings).toHaveBeenCalledWith(HARNESS_CONTENT.crossings);
      expect(directorCrossings).toHaveBeenCalledWith(HARNESS_CONTENT.crossings);
      expect(interactions.mock.calls).toEqual([
        ['vault_inspect', HARNESS_CONTENT.interactions.vault_inspect?.run, null],
        ['console_query', HARNESS_CONTENT.interactions.console_query?.run, null],
        ['gate_overclock', HARNESS_CONTENT.interactions.gate_overclock?.run, 'lumen'],
      ]);
      expect(directorInteractions).toHaveBeenCalledTimes(3);
      expect(directorInteractions).toHaveBeenLastCalledWith('gate_overclock', HARNESS_CONTENT.interactions.gate_overclock?.run, 'lumen');
    });
    expect(order).toEqual(['kernel:none', 'kernel:none', 'kernel:0', 'configure']);
    expect(session.runner.kernel?.tick).toBe(0);
    // The companion's crossing is now resolvable by the director.
    expect(() => session.runner.openCrossing(HARNESS_CROSSING)).not.toThrow();
    session.detach();
  });

  it('does not call configure when entry is skipped, and enter without configure is unchanged', () => {
    const failing: Leg = { ...createHarnessLeg(), populate: () => { throw new Error('populate refused'); } };
    const session = new HarnessSession(4, makeRunState({ seed: 4, legIndex: 1 }), 0.1);
    const configure = vi.fn();
    session.runner.enter(failing, { maxTicks: 50, stageContext: null }, configure);
    expect(configure).not.toHaveBeenCalled();
    expect(session.runner.finished).toBe(true);
    expect(session.collectors.legFailures.map((failure) => failure.phase)).toEqual(['populate']);
    const plain = new HarnessSession(5, makeRunState({ seed: 5, legIndex: 1 }), 0.1);
    plain.runner.enter(createHarnessLeg(), { maxTicks: 50, stageContext: null });
    expect(plain.runner.director).not.toBeNull();
    expect(() => plain.runner.registerInteraction('vault_inspect', noop, null)).not.toThrow();
    plain.detach();
  });
});

describe('CommandRegistry.register', () => {
  it('accepts a byte-identical re-registration and throws on a differing one naming the first differing line (acceptance 5)', () => {
    const f = makeFixture();
    f.shell.registerAll(ALL_DEFINITIONS);
    const names = f.shell.registry.names();
    expect(() => f.shell.registerAll(ALL_DEFINITIONS)).not.toThrow();
    expect(f.shell.registry.names()).toEqual(names);
    const curriculum = curriculumDefinitions();
    for (const name of WAVE_A_COMMANDS) {
      const def = curriculum.get(name);
      expect(def, name).toBeDefined();
      expect(() => f.shell.register(def!), name).not.toThrow();
    }
    expect(f.shell.registry.names()).toEqual(names);
    const gantt = curriculum.get('gantt')!;
    expect(firstDefinitionDifference(gantt, { ...gantt })).toBeNull();
    expect(() => f.shell.register({ ...gantt, manual: gantt.manual.replace('--replay', '--rerun') })).toThrow(/terminal command 'gantt' is already registered with a different definition; first differing line: registered "manual\[\d+\]: .*--replay.*" versus new "manual\[\d+\]: .*--rerun/);
    expect(() => f.shell.register({ ...gantt, summary: 'changed' })).toThrow(/first differing line: registered "summary: /);
    expect(firstDefinitionDifference(gantt, { ...gantt, chapter: null })).toEqual({ registered: 'chapter: 5 "CPU Scheduling" [5.2, 5.8.1, 5.8.2]', candidate: 'chapter: null' });
    expect(firstDefinitionDifference(gantt, { ...gantt, manual: `${gantt.manual}\nmore` })?.registered).toBe('<end of definition>');
    // The pending (deferred) path behaves the same way.
    const hyper = curriculum.get('hyper')!;
    expect(() => f.shell.register(hyper)).not.toThrow();
    expect(() => f.shell.register({ ...hyper, usage: 'hyper' })).toThrow(/first differing line: registered "usage: /);
  });

  it('Shell.onCommand fires once per submission that names a command, with the result (acceptance 6)', () => {
    const f = makeFixture();
    f.shell.registerAll(ALL_DEFINITIONS);
    const calls: [string, readonly string[], CommandResult][] = [];
    const off = f.shell.onCommand((name, argv, result) => { calls.push([name, argv, result]); });
    const listed = f.shell.execute('ps');
    expect(calls).toEqual([['ps', [], listed]]);
    const unknown = f.shell.execute('nosuch --x 1');
    expect(unknown.ok).toBe(false);
    expect(calls[1]).toEqual(['nosuch', ['--x', '1'], unknown]);
    f.shell.execute('');
    f.shell.execute('ps | top');
    expect(calls).toHaveLength(2);
    const help = f.shell.execute('gantt --help');
    expect(calls[2]).toEqual(['gantt', ['--help'], help]);
    const second = f.shell.onCommand(() => { calls.push(['second', [], listed]); });
    f.shell.execute('ps');
    expect(calls.slice(3).map((call) => call[0])).toEqual(['ps', 'second']);
    off();
    second();
    f.shell.execute('ps');
    expect(calls).toHaveLength(5);
  });
});

describe('codex command and metric arms', () => {
  it('match through Codex.signal, with nth counted per entry and above strict (acceptance 7)', () => {
    const registry = new CodexRegistry();
    registry.register(codexEntry('fx.criteria', { kind: 'command', name: 'gantt', flag: '--metrics' }));
    registry.register(codexEntry('fx.sjf', { kind: 'command', name: 'gantt', flag: '--replay', nth: 3 }));
    registry.register(codexEntry('fx.any_gantt', { kind: 'command', name: 'gantt', nth: 2 }));
    registry.register(codexEntry('fx.levels', { kind: 'command', name: 'sched', flag: '--levels' }));
    registry.register(codexEntry('fx.overhead', { kind: 'metric', id: 'scheduling.contextSwitchOverhead', above: 0.15 }));
    const store = createRunStore(makeRunState({ seed: 1, legIndex: 3 }));
    const codex = new Codex({ registry, runStore: store, currentLeg: () => 'quantum_pass' });
    const unlocked: string[] = [];
    codex.onUnlock((id) => unlocked.push(id));
    codex.signal({ kind: 'command', name: 'gantt', argv: ['--replay', 'sjf'] });
    expect(unlocked).toEqual([]);
    codex.signal({ kind: 'command', name: 'gantt', argv: ['--metrics'] });
    expect(unlocked).toEqual(['fx.criteria', 'fx.any_gantt']);
    codex.signal({ kind: 'command', name: 'sched', argv: ['--replay', 'fcfs'] });
    codex.signal({ kind: 'command', name: 'gantt', argv: ['--replay', 'fcfs'] });
    expect(unlocked).toEqual(['fx.criteria', 'fx.any_gantt']);
    codex.signal({ kind: 'command', name: 'gantt', argv: ['--replay', 'priority'] });
    expect(unlocked).toEqual(['fx.criteria', 'fx.any_gantt', 'fx.sjf']);
    codex.signal({ kind: 'metric', id: 'scheduling.contextSwitchOverhead', value: 0.15 });
    codex.signal({ kind: 'metric', id: 'memory.faultRate', value: 1 });
    expect(unlocked).toHaveLength(3);
    codex.signal({ kind: 'metric', id: 'scheduling.contextSwitchOverhead', value: 0.1501 });
    expect(unlocked).toEqual(['fx.criteria', 'fx.any_gantt', 'fx.sjf', 'fx.overhead']);
    expect(store.get().codexUnlocked).toEqual(unlocked);
    expect(codex.open('fx.sjf').kind).toBe('readable');
    expect(codex.open('fx.levels').kind).toBe('locked');
    codex.signal({ kind: 'command', name: 'sched', argv: ['--levels', '4,8,16'] });
    expect(codex.open('fx.levels').kind).toBe('readable');
    codex.dispose();
  });

  it('pure matching: command and metric, and the six existing arms ignore the new signals', () => {
    const command = { kind: 'command', name: 'gantt', argv: ['--metrics'] } as const;
    expect(isCommandOccurrence({ kind: 'command', name: 'gantt' }, command)).toBe(true);
    expect(isCommandOccurrence({ kind: 'command', name: 'gantt', flag: '--replay' }, command)).toBe(false);
    expect(isCommandOccurrence({ kind: 'command', name: 'sched' }, command)).toBe(false);
    expect(matchesUnlock({ kind: 'command', name: 'gantt', flag: '--metrics' }, command)).toBe(true);
    expect(matchesUnlock({ kind: 'command', name: 'gantt', nth: 2 }, command)).toBe(false);
    expect(matchesUnlock({ kind: 'command', name: 'gantt', nth: 2 }, command, 2)).toBe(true);
    expect(matchesUnlock({ kind: 'command', name: 'gantt', nth: 2 }, command, 3)).toBe(false);
    expect(matchesUnlock({ kind: 'metric', id: 'x', above: 1 }, { kind: 'metric', id: 'x', value: 1 })).toBe(false);
    expect(matchesUnlock({ kind: 'metric', id: 'x', above: 1 }, { kind: 'metric', id: 'x', value: 1.001 })).toBe(true);
    expect(matchesUnlock({ kind: 'metric', id: 'x', above: 1 }, { kind: 'metric', id: 'y', value: 5 })).toBe(false);
    const existing: readonly CodexUnlock[] = [
      { kind: 'affliction', id: 'starvation' }, { kind: 'termination', reason: 'starvation' }, { kind: 'event', type: 'process.starving' },
      { kind: 'objective', id: 'gantt' }, { kind: 'crossing', option: 'spin' }, { kind: 'leg_complete', leg: 'quantum_pass' },
    ];
    for (const unlock of existing) {
      expect(matchesUnlock(unlock, command), unlock.kind).toBe(false);
      expect(matchesUnlock(unlock, { kind: 'metric', id: 'gantt', value: 9 }), unlock.kind).toBe(false);
    }
    expect(matchesUnlock({ kind: 'command', name: 'gantt' }, { kind: 'objective', id: 'gantt' })).toBe(false);
    expect(structureFor({ kind: 'command', name: 'gantt' })).toBeNull();
    expect(structureFor({ kind: 'metric', id: 'x', above: 0 })).toBeNull();
  });
});

describe('asKernelEvents', () => {
  it('narrows a KernelEvent[] unchanged and throws on an element with no tick (acceptance 15)', () => {
    const events: readonly KernelEvent[] = [
      { type: 'context.switch', tick: asTick(1), seq: 1, from: null, to: asPid(2), rationale: 'first dispatch' },
      { type: 'process.starving', tick: asTick(120), seq: 2, pid: asPid(3), waitedTicks: 120, fatal: false },
    ];
    expect(asKernelEvents(events)).toBe(events);
    expect(asKernelEvents([])).toEqual([]);
    const starving = asKernelEvents(events)[1];
    expect(starving?.type === 'process.starving' && starving.fatal).toBe(false);
    expect(() => asKernelEvents([{ type: 'process.starving' }])).toThrow(/asKernelEvents: event 0 \(process.starving\) has no tick and seq/);
    expect(() => asKernelEvents([events[0]!, { type: 'quantum.expired', seq: 3 } as { type: string }])).toThrow(/event 1 \(quantum.expired\)/);
    expect(() => asKernelEvents([{ type: 'quantum.expired', tick: 3 } as { type: string }])).toThrow(/event 0/);
  });
});

describe('src/legs boundaries', () => {
  it('nothing under src/legs imports three, @world, @render, @ui or @audio at any scope (acceptance 17)', () => {
    const files = collect(resolve(REPO_ROOT, 'src', 'legs'));
    expect(files.map((file) => relative(REPO_ROOT, file))).toEqual(expect.arrayContaining(['src/legs/content.ts', 'src/legs/epitaphs.ts', 'src/legs/events.ts', 'src/legs/layout.ts', 'src/legs/legs.d.ts', 'src/legs/registry.ts']));
    const anywhere = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:three(?:['"]|\/)|@world|@render|@ui|@audio)/;
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), false);
      expect(scanForbiddenImports(code), file).toEqual([]);
      expect(code, file).not.toMatch(anywhere);
    }
    // The content module value-imports only the game layer and its own layout module (pre-flight ruling 2).
    const content = stripComments(readFileSync(resolve(REPO_ROOT, 'src', 'legs', 'content.ts'), 'utf8'), false);
    const valueImports = [...content.matchAll(/^import\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(valueImports).toEqual(['@game/replay/runReplay']);
  });
});

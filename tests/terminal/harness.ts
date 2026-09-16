/**
 * Shared fixtures for the WP-15 suites: a real kernel, a recording sink that
 * applies each mutator and appends one DecisionRecord per dispatch, a host
 * bound through the game layer, and the curriculum map's definitions parsed
 * from docs/ so fidelity is asserted against the source rather than a copy.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKernel, type KernelImpl, type KernelOptions } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import type { KernelConfig, Pid } from '@kernel/types';
import { LEG_ORDER, type RunState, type TerminalCommandDef } from '@game/types';
import { createTerminalHost, type CommandSink, type TerminalCommandRequest, type TerminalHost } from '@game/terminalHost';
import { Shell, type ShellOptions } from '@terminal/Shell';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import { resolveTopic } from '@terminal/man/ManPages';
import type { CommandResult } from '@terminal/registry';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';

export const ROOT = resolve(__dirname, '..', '..');

export function makeKernel(overrides: Partial<KernelConfig> = {}, tuning: KernelOptions = {}): KernelImpl {
  return createKernel({ ...REFERENCE_CONFIG, ...overrides }, { threadCreateTicks: 0, contextSwitchTicks: 0, ...tuning });
}

export function fixtureRun(): RunState {
  return {
    runId: 'wp15-fixture', seed: 7, discClass: 'shell', difficulty: 'operator', legIndex: 0, legProgress: 0,
    convoy: [], resources: { cycles: 100, quota: 64, blocks: 32, bandwidth: 16 },
    policy: { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 8 },
    tombstones: [], codexUnlocked: [], objectivesMet: [], decisions: [],
    score: { survivors: 0, throughput: 0, efficiency: 0, correctness: 0, conceptsMastered: 0, classMultiplier: 1, total: 0 },
    status: 'in_progress',
  };
}

export interface RecordingSink extends CommandSink { readonly dispatched: TerminalCommandRequest[] }

/** Applies the mutator on the real kernel and appends exactly one DecisionRecord per dispatch. */
export function recordingSink(kernel: KernelImpl, run: RunState): RecordingSink {
  const dispatched: TerminalCommandRequest[] = [];
  return {
    dispatched,
    dispatch(request, origin) {
      dispatched.push(request);
      const legId = LEG_ORDER[run.legIndex] ?? 'boot_sector';
      const record = { tick: kernel.tick, legId, kind: request.kind, choice: origin.line, outcome: 'pending' as const, relatedObjective: null };
      try {
        switch (request.kind) {
          case 'set_scheduler': kernel.setScheduler(request.id, request.params); break;
          case 'set_replacement': kernel.setReplacementPolicy(request.id); break;
          case 'set_disk': kernel.setDiskPolicy(request.id); break;
          case 'set_allocation': kernel.setAllocationStrategy(request.strategy); break;
          case 'set_pace': run.policy.pace = request.pace; break;
          case 'set_rations': run.policy.rations = request.rations; break;
          case 'set_degree': kernel.setDegreeOfMultiprogramming(request.degree); run.policy.degreeOfMultiprogramming = request.degree; break;
          case 'set_deadlock_strategy': kernel.setDeadlockStrategy(request.strategy); break;
          case 'syscall': { run.decisions.push(record); return { ok: true, syscall: kernel.syscall(request.request) }; }
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      run.decisions.push(record);
      return { ok: true };
    },
  };
}

export interface Fixture {
  readonly kernel: KernelImpl;
  readonly run: RunState;
  readonly sink: RecordingSink;
  readonly host: TerminalHost;
  readonly shell: Shell;
}

export function makeFixture(kernel: KernelImpl = makeKernel(), options: ShellOptions = {}): Fixture {
  const run = fixtureRun();
  const sink = recordingSink(kernel, run);
  const host = createTerminalHost(kernel, sink, () => run);
  const shell = new Shell(host, options);
  return { kernel, run, sink, host, shell };
}

/** Every failure any suite produced, so one test can assert each names a topic that resolves (acceptance 11). */
export const ERRORS: { readonly line: string; readonly result: Extract<CommandResult, { ok: false }> }[] = [];

export function runLine(shell: Shell, line: string): CommandResult {
  const result = shell.execute(line);
  if (!result.ok) ERRORS.push({ line, result });
  return result;
}

export function expectOk(shell: Shell, line: string): readonly string[] {
  const result = runLine(shell, line);
  expect(result.ok, `${line}: ${result.ok ? '' : result.message}`).toBe(true);
  return result.ok ? result.lines : [];
}

export function expectError(shell: Shell, line: string): Extract<CommandResult, { ok: false }> {
  const result = runLine(shell, line);
  expect(result.ok, `${line} should fail`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result;
}

export function runUntil(kernel: KernelImpl, condition: () => boolean, limit = 500): void {
  for (let count = 0; count < limit && !condition(); count++) kernel.step();
  expect(condition()).toBe(true);
}

/** A process stepped until it holds the CPU, with a long compute program. */
export function runningProcess(kernel: KernelImpl, name = 'worker', service = 400): Pid {
  const pid = kernel.spawn({ name, priority: 1, arrival: 0, burst: service, service, pages: 2 }, { program: instructionProgram([{ kind: 'compute' }]) });
  runUntil(kernel, () => kernel.process(pid)?.state === 'running', 50);
  return pid;
}

/** A process that has exited and now waits for its parent to reap it. Any admitted process may call exit (WP-11 decision D3). */
export function makeZombie(kernel: KernelImpl, parent?: Pid): Pid {
  const options = parent === undefined ? { program: instructionProgram([{ kind: 'compute' }]) } : { program: instructionProgram([{ kind: 'compute' }]), parent };
  const pid = kernel.spawn({ name: 'zombie', priority: 1, arrival: 0, burst: 400, service: 400, pages: 0 }, options);
  runUntil(kernel, () => kernel.process(pid)?.state !== 'new', 50);
  expect(kernel.syscall({ name: 'exit', pid, args: [0] })).toEqual({ ok: true, value: null });
  expect(kernel.process(pid)?.state).toBe('zombie');
  return pid;
}

/** The literal `TerminalCommandDef` arrays of every leg in docs/05-CURRICULUM-MAP.md, evaluated as written. */
export function curriculumDefinitions(): ReadonlyMap<string, TerminalCommandDef> {
  const doc = readFileSync(resolve(ROOT, 'docs', '05-CURRICULUM-MAP.md'), 'utf8');
  const defs = new Map<string, TerminalCommandDef>();
  const section = /### Terminal commands introduced\n\n```ts\nconst terminalCommands: readonly TerminalCommandDef\[\] = (\[[\s\S]*?\n\]);\n```/g;
  for (const match of doc.matchAll(section)) {
    const literal = match[1];
    if (literal === undefined) continue;
    const array = new Function(`return ${literal};`)() as TerminalCommandDef[];
    for (const def of array) {
      if (defs.has(def.name)) throw new Error(`curriculum map defines ${def.name} twice`);
      defs.set(def.name, def);
    }
  }
  if (defs.size === 0) throw new Error('no terminal command definitions found in the curriculum map');
  return defs;
}

/**
 * Acceptance 11 for one suite: vitest isolates each test file's modules, so
 * every suite calls this on its own ERRORS at the end. A full shell (all 49
 * definitions) is the resolver, because a base shell cannot know a leg's page.
 */
export function expectErrorsNameTopics(): void {
  const f = makeFixture();
  f.shell.registerAll(ALL_DEFINITIONS);
  expect(ERRORS.length).toBeGreaterThan(0);
  for (const { line, result } of ERRORS) {
    expect(result.topic, line).not.toBe('');
    expect(result.message, line).toContain(result.topic);
    expect(resolveTopic(result.topic, f.shell.registry, f.host), `${line} -> ${result.topic}`).not.toBeNull();
  }
}

/**
 * WP-15: one describe per command group. For every implemented command: a
 * success case, a live-state case (acceptance 6: the output changes when the
 * state it reads changes), and an error case naming its man topic. Plus the
 * cross-cutting cases the package names: definition fidelity, no invented
 * commands, no direct mutation, decisions recorded, the zombie and busy-wait
 * columns, the strace, the Banker's trace, the wait-for cycle and the Gantt
 * golden.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKernel } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import type { Actor } from '@kernel/sync/SyncSubsystem';
import { asResourceId, asTick } from '@kernel/types';
import { ALL_DEFINITIONS, BASE_COMMAND_NAMES, SHIPPED_HANDLERS } from '@terminal/commands/index';
import { DEFERRED_COMMANDS } from '@terminal/registry';
import { createWorkloadKernel } from '../kernel/scheduler/workloadRunner';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';
import { curriculumDefinitions, ERRORS, expectError, expectOk, makeFixture, makeKernel, makeZombie, ROOT, runningProcess, runUntil } from './harness';

const DEFINED = curriculumDefinitions();

function shellWith(names: readonly string[], kernel = makeKernel()) {
  const fixture = makeFixture(kernel);
  for (const name of names) {
    const def = DEFINED.get(name);
    if (def === undefined) throw new Error(`no curriculum definition for ${name}`);
    fixture.shell.register(def);
  }
  return fixture;
}

describe('definitions', () => {
  it('definition fidelity: every shipped definition is byte-identical to the curriculum map (acceptance 4)', () => {
    expect(ALL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const def of ALL_DEFINITIONS) {
      const source = DEFINED.get(def.name);
      expect(source, def.name).toBeDefined();
      expect(def.usage, def.name).toBe(source?.usage);
      expect(def.summary, def.name).toBe(source?.summary);
      expect(def.manual, def.name).toBe(source?.manual);
      expect(def.chapter, def.name).toEqual(source?.chapter);
    }
  });

  it('no invented commands: every shipped name and every handler name is defined by the curriculum map (acceptance 5)', () => {
    for (const def of ALL_DEFINITIONS) expect(DEFINED.has(def.name), def.name).toBe(true);
    for (const name of SHIPPED_HANDLERS.keys()) expect(DEFINED.has(name), name).toBe(true);
    for (const name of DEFERRED_COMMANDS) expect(DEFINED.has(name), name).toBe(true);
    expect(new Set(ALL_DEFINITIONS.map(def => def.name)).size).toBe(ALL_DEFINITIONS.length);
    expect(BASE_COMMAND_NAMES).toHaveLength(14);
  });

  it('no direct mutation: no terminal source calls a kernel setter, restore or syscall (acceptance 7)', () => {
    const files = ['Shell.ts', 'commands/base.ts', 'commands/process.ts', 'commands/scheduler.ts', 'commands/index.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(ROOT, 'src', 'terminal', file), 'utf8');
      expect(source, file).not.toMatch(/\.(setScheduler|setReplacementPolicy|setDiskPolicy|setAllocationStrategy|restore|syscall)\s*\(/);
    }
  });
});

describe('shell', () => {
  it('names the nearest command for an unknown one and prints usage for --help', () => {
    const f = shellWith(['ps', 'pstree']);
    const error = expectError(f.shell, 'pss');
    expect(error.topic).toBe('ps');
    expect(error.message).toContain("nearest is 'ps'");
    const help = expectOk(f.shell, 'ps --help');
    expect(help[0]).toBe(DEFINED.get('ps')?.usage);
    expect(help[2]).toContain('Z zombie');
    expect(expectOk(f.shell, '')).toEqual([]);
    const parse = expectError(f.shell, 'ps | top');
    expect(parse.topic).toBe('man');
  });

  it('refuses a definition without a handler unless it is deferred, and a duplicate registration', () => {
    const f = makeFixture();
    expect(() => f.shell.register({ name: 'nosuch', usage: 'nosuch', summary: 'x', manual: 'x', chapter: null })).toThrow(/no handler/);
    const hyper = DEFINED.get('hyper');
    if (hyper === undefined) throw new Error('hyper undefined');
    f.shell.register(hyper);
    expect(() => f.shell.register(hyper)).toThrow(/already registered/);
    const before = expectError(f.shell, 'hyper --traps');
    expect(before.topic).toBe('hyper');
    f.shell.registerHandler('hyper', () => ({ ok: true, lines: ['handled by the leg'] }));
    expect(expectOk(f.shell, 'hyper')).toEqual(['handled by the leg']);
  });
});

describe('base commands', () => {
  it('syscall issues the call through the sink as the running process and prints the result', () => {
    const f = shellWith(['syscall']);
    const pid = runningProcess(f.kernel);
    const lines = expectOk(f.shell, 'syscall getpid');
    expect(lines[0]).toBe(`getpid() = ${pid}`);
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'getpid', pid, args: [] } }]);
    expect(expectOk(f.shell, 'syscall getpid --pid 1')[0]).toBe('getpid() = 1');
    expect(expectOk(f.shell, `syscall kill ${pid} 0`)[0]).toBe(`kill(${pid}, 0) = null`);
  });

  it('syscall live: the caller follows the processor', () => {
    const f = shellWith(['syscall'], makeKernel({ scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 } }));
    const a = runningProcess(f.kernel, 'a');
    const first = expectOk(f.shell, 'syscall getpid')[0];
    runningProcess(f.kernel, 'b');
    runUntil(f.kernel, () => f.kernel.process(a)?.state !== 'running', 5);
    expect(expectOk(f.shell, 'syscall getpid')[0]).not.toBe(first);
  });

  it('syscall errors name the errno topic, and an unknown call names the nearest one', () => {
    const f = shellWith(['syscall']);
    runningProcess(f.kernel);
    const unknown = expectError(f.shell, 'syscall fork_bomb');
    expect(unknown.topic).toBe('fork');
    const failed = expectError(f.shell, 'syscall kill 999 0');
    expect(failed.errno).toBe('ESRCH');
    expect(failed.topic).toBe('ESRCH');
    expect(failed.message).toContain('ESRCH');
  });

  it('mode reports idle, user and kernel from the live view and its history from the rings', () => {
    const f = shellWith(['mode']);
    expect(expectOk(f.shell, 'mode')[0]).toContain('idle');
    const pid = runningProcess(f.kernel, 'worker');
    expect(expectOk(f.shell, 'mode')[0]).toBe(`mode: user, on behalf of worker (P${pid})`);
    f.kernel.syscall({ name: 'getpid', pid, args: [] });
    const history = expectOk(f.shell, 'mode --history');
    expect(history.some(line => /trap/.test(line) && /getpid/.test(line))).toBe(true);
    expect(expectError(f.shell, 'mode --bogus').topic).toBe('mode');
  });
});

describe('process commands', () => {
  it('ps lists live processes, prints Z for a zombie and the long form for -l (acceptance 15)', () => {
    const f = shellWith(['ps']);
    const before = expectOk(f.shell, 'ps');
    const pid = makeZombie(f.kernel);
    const after = expectOk(f.shell, 'ps');
    expect(after).not.toEqual(before);
    const row = after.find(line => new RegExp(`^\\s*${pid}\\s`).test(line));
    expect(row).toMatch(new RegExp(`^\\s*${pid}\\s+Z\\s+zombie$`));
    const long = expectOk(f.shell, `ps -l ${pid}`);
    expect(long[0]).toMatch(/^PID\s+PPID\s+STATE\s+PRI\s+BURST\s+SVC\s+BLOCKED\s+AS\s+NAME$/);
    expect(long[1]).toContain('zombie');
    expect(expectOk(f.shell, 'ps -e').some(line => /^\s*1\s/.test(line))).toBe(true);
    expect(expectOk(f.shell, 'ps').some(line => /^\s*1\s/.test(line))).toBe(false);
    const error = expectError(f.shell, 'ps 999');
    expect(error.errno).toBe('ESRCH');
    expect(error.topic).toBe('ps');
  });

  it('kill on a zombie returns ESRCH from the kernel and prints it (acceptance 13)', () => {
    const f = shellWith(['kill']);
    const live = runningProcess(f.kernel, 'victim');
    expect(expectOk(f.shell, `kill -s 0 ${live}`)[0]).toContain('exists');
    expect(expectOk(f.shell, `kill ${live}`)[0]).toBe(`sent signal 9 to P${live}`);
    expect(f.kernel.process(live)?.state).toBe('zombie');
    expect(f.kernel.process(live)?.terminationReason).toBe('killed_by_user');
    const zombie = expectError(f.shell, `kill ${live}`);
    expect(zombie.errno).toBe('ESRCH');
    expect(zombie.message).toContain('ESRCH');
    expect(zombie.topic).toBe('ESRCH');
    expect(f.sink.dispatched.filter(request => request.kind === 'syscall')).toHaveLength(3);
    expect(expectError(f.shell, 'kill -s hup 3').topic).toBe('kill');
  });

  it('wait reaps a zombie as its parent, refuses to block on a live child, and -a sweeps', () => {
    const f = shellWith(['wait']);
    const parent = runningProcess(f.kernel, 'parent');
    const child = makeZombie(f.kernel, parent);
    const live = expectError(f.shell, `wait ${parent}`);
    expect(live.topic).toBe('wait');
    expect(live.message).toContain('not a zombie');
    const reaped = expectOk(f.shell, `wait ${child}`);
    expect(reaped[0]).toBe(`reaped P${child} (zombie) exit status 0, by parent P${parent}`);
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'wait', pid: parent, args: [child] } }]);
    expect(f.kernel.process(child)?.state ?? 'terminated').toBe('terminated');
    const none = expectOk(f.shell, 'wait -a');
    expect(none[0]).toContain('no zombies');
    const second = makeZombie(f.kernel, parent);
    expect(expectOk(f.shell, 'wait -a')[0]).toContain(`reaped P${second}`);
    expect(expectError(f.shell, 'wait 999').errno).toBe('ESRCH');
  });

  it('pstree draws parents and children with a hollow marker for zombies', () => {
    const f = shellWith(['pstree']);
    const before = expectOk(f.shell, 'pstree');
    const parent = runningProcess(f.kernel, 'parent');
    const child = makeZombie(f.kernel, parent);
    const after = expectOk(f.shell, 'pstree');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.includes(`o zombie(${child}) zombie`))).toBe(true);
    expect(after.some(line => line.includes(`* parent(${parent})`))).toBe(true);
    expect(expectOk(f.shell, `pstree ${parent}`)[0]).toContain(`parent(${parent})`);
    expect(expectError(f.shell, 'pstree 999').errno).toBe('ESRCH');
  });

  it('ipc lists live mailboxes and refuses --bind with its topic', () => {
    const f = shellWith(['ipc']);
    const before = expectOk(f.shell, 'ipc --channels');
    f.kernel.ipc.createMailbox(asResourceId('survey'), 4);
    const after = expectOk(f.shell, 'ipc');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('survey'))).toBe(true);
    expect(expectError(f.shell, 'ipc --bind shm survey_dump').topic).toBe('ipc');
  });

  it('threads lists the live thread table and refuses the unmodelled flags', () => {
    const f = shellWith(['threads']);
    const before = expectOk(f.shell, 'threads');
    const pid = f.kernel.spawn({ name: 'weave', priority: 1, arrival: 0, burst: 50, service: 50, pages: 0 }, { threadCount: 3, program: instructionProgram([{ kind: 'compute' }]) });
    f.kernel.step();
    const after = expectOk(f.shell, `threads ${pid}`);
    expect(after).not.toEqual(before);
    expect(after.length).toBe(2 + 3);
    expect(expectError(f.shell, 'threads --cancel 1').topic).toBe('threads');
    expect(expectError(f.shell, 'threads 999').errno).toBe('ESRCH');
  });

  it('amdahl computes the ceiling and defaults cores and strands from live state', () => {
    const f = shellWith(['amdahl']);
    const explicit = expectOk(f.shell, 'amdahl --serial 0.25 --cores 4');
    expect(explicit.find(line => line.startsWith('ceiling at cores'))).toContain('2.29x');
    expect(explicit.find(line => line.startsWith('limit'))).toContain('4.00x');
    const before = expectOk(f.shell, 'amdahl --serial 0.3');
    f.kernel.spawn({ name: 'weave', priority: 1, arrival: 0, burst: 50, service: 50, pages: 0 }, { threadCount: 2, program: instructionProgram([{ kind: 'compute' }]) });
    runUntil(f.kernel, () => f.kernel.processes.some(pcb => pcb.state === 'running'), 10);
    expect(expectOk(f.shell, 'amdahl --serial 0.3')).not.toEqual(before);
    expect(expectError(f.shell, 'amdahl --serial 2').topic).toBe('amdahl');
    expect(expectError(f.shell, 'amdahl').topic).toBe('amdahl');
  });

  it('top columns: spin% and poll% are distinct from user%, and a busy-waiter shows spin with zero work (acceptance 16)', () => {
    const resource = asResourceId('atomic:lock');
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr',
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, enabledSubsystems: ['process', 'scheduler', 'sync'] },
    { threadCreateTicks: 0, contextSwitchTicks: 0 });
    const program = instructionProgram([{ kind: 'sync', operation: { op: 'scenario', scenario: 'spin', step: 0 } }]);
    const actor = (name: string): Actor => {
      const pid = kernel.spawn({ name, priority: 1, burst: 1000, service: 1000, arrival: 0, pages: 0 }, { program, serialFraction: 1 });
      return { pid, tid: kernel.process(pid)?.threads[0] ?? (0 as Actor['tid']) };
    };
    const holder = actor('holder'); const spinner = actor('spinner');
    kernel.syncSubsystem.createAtomicLock(resource, 'tas', [holder, spinner], 'lock');
    kernel.syncSubsystem.addScenario({ id: 'spin', kind: 'spinlock', resource, criticalTicks: 1, remainderTicks: 0, iterationLimit: null,
      actors: [holder, spinner].map(a => ({ actor: a, completedEntries: 0 })) });
    kernel.step(); kernel.blockProcess(holder.pid, { kind: 'sleep', untilTick: asTick(200) });
    const f = shellWith(['top'], kernel);
    const before = expectOk(f.shell, 'top');
    kernel.run(100);
    const after = expectOk(f.shell, 'top');
    expect(after).not.toEqual(before);
    expect(after[1]).toMatch(/PID\s+NAME\s+S\s+PRI\s+user%\s+work%\s+spin%\s+poll%/);
    const row = after.find(line => line.includes('spinner'));
    expect(row).toBeDefined();
    const cells = (row ?? '').trim().split(/\s+/);
    expect(cells[4]).not.toBe('0.0%');
    expect(cells[5]).toBe('0.0%');
    expect(cells[6]).not.toBe('0.0%');
    expect(cells[6]).toBe(cells[4]);
    expect(cells[7]).toBe('0.0%');
    expect(after[0]).toMatch(/cpu user \d+\.\d% sys \d+\.\d% idle \d+\.\d%/);
    expect(expectOk(f.shell, 'top -H')[1]).toMatch(/^TID\s+PID/);
    expect(expectError(f.shell, 'top -n zero').topic).toBe('top');
  });
});

describe('scheduler commands', () => {
  it('sched prints the live policy and metrics, and applies a change through exactly one dispatch', () => {
    const f = shellWith(['sched']);
    const before = expectOk(f.shell, 'sched');
    expect(before.some(line => /^policy\s+fcfs$/.test(line))).toBe(true);
    const applied = expectOk(f.shell, 'sched --policy srtf --quantum 3');
    expect(applied[0]).toContain('scheduler set to srtf');
    // setScheduler leaves the initial config alone; the live view and the snapshot's config carry the change.
    expect(f.host.view().schedulerId).toBe('srtf');
    expect(f.host.view().schedulerParams.quantum).toBe(3);
    expect(f.kernel.snapshot().config.scheduler).toBe('srtf');
    expect(f.run.decisions).toHaveLength(1);
    expect(f.run.decisions[0]).toMatchObject({ kind: 'set_scheduler', outcome: 'pending' });
    expect(f.sink.dispatched).toEqual([{ kind: 'set_scheduler', id: 'srtf', params: { quantum: 3 } }]);
    expect(expectOk(f.shell, 'sched')).not.toEqual(before);
    const error = expectError(f.shell, 'sched --policy bogus');
    expect(error.topic).toBe('sched');
    expect(error.message).toContain('fcfs, sjf, srtf');
    expect(f.run.decisions).toHaveLength(1);
  });

  it('nice adjusts the target through one syscall dispatch issued as the target', () => {
    const f = shellWith(['nice']);
    const pid = runningProcess(f.kernel);
    const first = expectOk(f.shell, `nice -n 5 ${pid}`);
    expect(first[0]).toBe(`P${pid} (worker) priority 1 -> 6`);
    expect(f.run.decisions).toHaveLength(1);
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'nice', pid, args: [5] } }]);
    expect(expectOk(f.shell, `nice -n 5 ${pid}`)).not.toEqual(first);
    expect(expectError(f.shell, 'nice -n 5 999').errno).toBe('ESRCH');
    expect(expectError(f.shell, `nice -n many ${pid}`).topic).toBe('nice');
  });

  it('gantt format: the chart equals the sched-fcfs-1 golden byte for byte', () => {
    const rows = [{ name: 'P1', arrival: 0, burst: 24 }, { name: 'P2', arrival: 0, burst: 3 }, { name: 'P3', arrival: 0, burst: 3 }];
    const { kernel } = createWorkloadKernel('fcfs', {}, rows);
    const f = shellWith(['gantt'], kernel);
    let completions = 0;
    kernel.events.on('process.exited', () => { completions += 1; });
    const early = expectOk(f.shell, 'gantt');
    while (completions < rows.length && kernel.tick < 10_000) kernel.step();
    const lines = expectOk(f.shell, 'gantt');
    expect(lines).toHaveLength(1);
    expect(`${lines.join('\n')}\n`).toBe(readFileSync(resolve(ROOT, 'tests', 'kernel', 'golden', 'sched-fcfs-1.gantt'), 'utf8'));
    expect(lines).not.toEqual(early);
    expect(expectOk(f.shell, 'gantt --last 3')[0]).toBe('P3[27-30]');
    expect(expectOk(f.shell, 'gantt --last 6')[0]).toBe('P2[24-27] P3[27-30]');
    expect(expectOk(f.shell, 'gantt --metrics').some(line => line.startsWith('waiting time'))).toBe(true);
    expect(expectError(f.shell, 'gantt --replay sjf').topic).toBe('gantt');
  });
});

describe('errors', () => {
  it('every error produced by this file so far carries a topic and a message that names it', () => {
    expect(ERRORS.length).toBeGreaterThan(0);
    for (const { line, result } of ERRORS) {
      expect(result.topic, line).not.toBe('');
      expect(result.message, line).toContain(result.topic);
    }
  });
});


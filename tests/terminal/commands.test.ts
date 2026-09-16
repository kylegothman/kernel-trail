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
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { Instruction, Program } from '@kernel/process/Program';
import type { DeviceId, DomainId } from '@kernel/types';
import { createBoundedBuffer } from '@kernel/sync/scenarios/boundedBuffer';
import { createReadersWriters } from '@kernel/sync/scenarios/readersWriters';
import { ALL_DEFINITIONS, BASE_COMMAND_NAMES, SHIPPED_HANDLERS } from '@terminal/commands/index';
import { DEFERRED_COMMANDS } from '@terminal/registry';
import { createWorkloadKernel } from '../kernel/scheduler/workloadRunner';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';
import { curriculumDefinitions, ERRORS, expectError, expectErrorsNameTopics, expectOk, makeFixture, makeKernel, makeZombie, ROOT, runningProcess, runUntil } from './harness';

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
    expect(ALL_DEFINITIONS).toHaveLength(49);
    expect(ALL_DEFINITIONS.map(def => def.name).sort()).toEqual([...DEFINED.keys()].sort());
    expect(BASE_COMMAND_NAMES).toHaveLength(14);
  });

  it('no direct mutation: no terminal source calls a kernel setter, restore or syscall (acceptance 7)', () => {
    const files = ['Shell.ts', 'commands/base.ts', 'commands/process.ts', 'commands/scheduler.ts', 'commands/sync.ts', 'commands/deadlock.ts', 'commands/memory.ts',
      'commands/storage.ts', 'commands/io.ts', 'commands/filesystem.ts', 'commands/security.ts', 'commands/index.ts'];
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


function syncKernel() {
  return makeKernel({ scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, enabledSubsystems: ['process', 'scheduler', 'sync'] });
}

/** The unprotected counter of tests/kernel/sync/raceDetector.test.ts: two processes lose increments under RR q=1. */
function racingCounter() {
  const kernel = syncKernel();
  const cell = 'region:counter';
  const instructions: Instruction[] = [
    { kind: 'sync', operation: { op: 'load', cell, into: 'counter', rmw: true } },
    { kind: 'sync', operation: { op: 'add', into: 'counter', value: { kind: 'literal', value: 1 } } },
    { kind: 'sync', operation: { op: 'store', cell, value: { kind: 'register', name: 'counter' }, rmw: true } },
  ];
  const source = instructionProgram(instructions);
  const program: Program = { ...source, at: index => source.at(index % source.length) };
  const pids = [0, 1].map(index => kernel.spawn({ name: `counter:${index}`, priority: 20, arrival: 0, burst: 300, service: 300, pages: 1 }, { program, serialFraction: 1 }));
  const pcb = kernel.process(pids[0] ?? asPid(0));
  if (pcb === undefined) throw new Error('missing counter process');
  const region = asResourceId('counter');
  kernel.ipc.createSharedRegion({ id: region, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 });
  kernel.syncSubsystem.addRegionCell(cell, region);
  return { kernel, pids };
}

describe('sync commands', () => {
  it('lock lists live primitives with holders and queues, and refuses the write flags', () => {
    const f = shellWith(['lock'], syncKernel());
    const before = expectOk(f.shell, 'lock --list');
    const lock = asResourceId('ledger');
    f.kernel.syncSubsystem.createMutex(lock);
    const pid = runningProcess(f.kernel);
    expect(f.kernel.syscall({ name: 'mutex_lock', pid, args: [lock] }).ok).toBe(true);
    const after = expectOk(f.shell, 'lock');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('ledger') && line.includes(`P${pid}`))).toBe(true);
    expect(expectError(f.shell, 'lock --inherit on').topic).toBe('lock');
  });

  it('race lists detected races from the ring and shows the interleaving that caused one', () => {
    const { kernel } = racingCounter();
    const f = shellWith(['race'], kernel);
    expect(expectOk(f.shell, 'race')).toEqual(['no data races detected']);
    kernel.run(600);
    const list = expectOk(f.shell, 'race --list');
    expect(list.length).toBeGreaterThan(1);
    expect(list[0]).toMatch(/^\s*N\s+TICK\s+PARTICIPANTS/);
    const shown = expectOk(f.shell, 'race --show 1');
    expect(shown[1]).toMatch(/^expected \d+, got \d+$/);
    expect(shown.length).toBeGreaterThan(2);
    expect(expectOk(f.shell, 'race --expected').some(line => line.includes('lost'))).toBe(true);
    expect(expectError(f.shell, 'race --show 999').topic).toBe('race');
  });

  it('trace strace: its line count equals the syscall.invoked count over the same window (acceptance 17)', () => {
    const f = shellWith(['trace']);
    let invoked = 0;
    f.kernel.events.onAny(event => { if (event.type === 'syscall.invoked') invoked += 1; });
    const pid = runningProcess(f.kernel);
    f.kernel.syscall({ name: 'getpid', pid, args: [] });
    f.kernel.syscall({ name: 'kill', pid, args: [999, 0] });
    f.kernel.syscall({ name: 'nice', pid, args: [2] });
    f.kernel.run(5);
    const lines = expectOk(f.shell, 'trace');
    expect(invoked).toBeGreaterThan(0);
    expect(lines).toHaveLength(invoked);
    expect(lines.some(line => line.includes('kill(999, 0) = ESRCH'))).toBe(true);
    expect(lines.some(line => line.includes('getpid() = ' + String(pid)))).toBe(true);
    expect(expectOk(f.shell, `trace --pid ${pid}`).every(line => line.includes(`P${pid}`))).toBe(true);
    expect(expectOk(f.shell, `trace --from ${f.kernel.tick + 1}`)).toEqual([]);
    expect(expectError(f.shell, 'trace --replay 1').topic).toBe('trace');
    expect(expectError(f.shell, 'trace --from soon').topic).toBe('trace');
  });

  it('sem lists the live semaphores, the acquisition order of a process, and refuses --set', () => {
    const kernel = syncKernel();
    const buffer = createBoundedBuffer(kernel, {});
    const f = shellWith(['sem'], kernel);
    const before = expectOk(f.shell, 'sem --list');
    expect(before.some(line => line.startsWith(buffer.empty))).toBe(true);
    kernel.run(40);
    const after = expectOk(f.shell, 'sem');
    expect(after).not.toEqual(before);
    const producer = buffer.actors.find(actor => actor.role === 'producer');
    const order = expectOk(f.shell, `sem --order ${producer?.actor.pid ?? 0}`);
    expect(order[0]).toContain('acquisition order');
    expect(order.length).toBeGreaterThan(2);
    expect(expectOk(f.shell, `sem --trace ${buffer.mutex}`).length).toBeGreaterThan(1);
    expect(expectError(f.shell, 'sem --set empty 3').topic).toBe('sem');
  });

  it('buffer reads the live bounded buffer and refuses resizing', () => {
    const kernel = syncKernel();
    createBoundedBuffer(kernel, {});
    const f = shellWith(['buffer'], kernel);
    const before = expectOk(f.shell, 'buffer');
    expect(before[0]).toMatch(/^buffer\s+/);
    kernel.run(60);
    const after = expectOk(f.shell, 'buffer');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('produced') && !line.endsWith(' 0'))).toBe(true);
    expect(expectError(f.shell, 'buffer --capacity 8').topic).toBe('buffer');
    const empty = shellWith(['buffer']);
    expect(expectOk(empty.shell, 'buffer')).toEqual(['no bounded buffer is running']);
  });

  it('rwlock reports the live lock and scenario statistics and refuses --policy', () => {
    const kernel = syncKernel();
    createReadersWriters(kernel, { policy: 'writer_pref' });
    const f = shellWith(['rwlock'], kernel);
    const before = expectOk(f.shell, 'rwlock --stats');
    expect(before[0]).toBe('default policy writer_pref');
    kernel.run(300);
    const after = expectOk(f.shell, 'rwlock --stats');
    expect(after).not.toEqual(before);
    expect(after.some(line => /writer\s+P\d+\s+1/.test(line) || /reader\s+P\d+\s+[1-9]/.test(line))).toBe(true);
    expect(expectError(f.shell, 'rwlock --policy fair').topic).toBe('rwlock');
  });
});

/** The mixed resource-and-mutex cycle of tests/kernel/deadlock/detection.test.ts. */
function deadlockKernel() {
  const kernel = makeKernel({ scheduler: 'rr', deadlockStrategy: 'detect',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1, agingInterval: 0, starvationThreshold: 10_000, starvationFatalThreshold: 20_000 },
    enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'] }, { deadlockRecovery: 'none' });
  const resource = asResourceId('mixed:R'); const lock = asResourceId('mixed:lock');
  kernel.deadlockSubsystem.declare({ id: resource, displayName: 'R', totalInstances: 1, preemptible: false });
  kernel.syncSubsystem.createMutex(lock);
  const first = kernel.spawn({ name: 'resource-first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, { program: instructionProgram([
    { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource, 1] } },
    { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [lock] } },
  ]) });
  const second = kernel.spawn({ name: 'mutex-first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, { program: instructionProgram([
    { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [lock] } },
    { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource, 1] } },
  ]) });
  return { kernel, first, second, resource, lock };
}

/** The textbook allocation of sim spec 8.6.3 through the real resource table, as tests/kernel/deadlock/bankers.test.ts arranges it. */
function bankersKernel() {
  const kernel = makeKernel({ deadlockStrategy: 'detect', enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'] });
  const [A, B, C] = [asResourceId('A'), asResourceId('B'), asResourceId('C')];
  for (const [id, totalInstances] of [[A, 10], [B, 5], [C, 7]] as const) kernel.declareResource({ id, displayName: id, totalInstances, preemptible: false });
  const max = [[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]];
  const allocation = [[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]];
  const pids = max.map((_, index) => kernel.spawn({ name: `Bankers P${index}`, priority: 10, burst: 1000, service: 1000, arrival: 0, pages: 0 }, { program: instructionProgram([{ kind: 'compute' }]) }));
  const vector = (row: readonly number[]) => [A, B, C].map((id, j) => [id, row[j] ?? 0] as const);
  pids.forEach((pid, i) => { kernel.declareClaims(pid, vector(max[i] ?? [])); kernel.deadlockSubsystem.resources.grant(pid, vector(allocation[i] ?? [])); });
  kernel.setDeadlockStrategy('avoid');
  return { kernel, pids, A, B, C };
}

describe('deadlock commands', () => {
  it('wfg cycle: prints the cycle from detectDeadlock rotated to its lowest pid, matching the kernel report', () => {
    const d = deadlockKernel();
    const f = shellWith(['wfg'], d.kernel);
    const before = expectOk(f.shell, 'wfg');
    expect(before).toContain('no cycle');
    d.kernel.run(20);
    const report = d.kernel.detectDeadlock();
    expect(report?.cycle).toEqual([d.first, d.second]);
    const after = expectOk(f.shell, 'wfg --cycle');
    expect(after).not.toEqual(before);
    expect(after).toContain(`cycle: P${d.first} -> P${d.second} -> P${d.first}`);
    expect(after.some(line => line.startsWith(`P${d.first} -> P${d.second}`))).toBe(true);
    expect(after.some(line => line.startsWith(`P${d.second} -> P${d.first}`))).toBe(true);
    const explained = expectOk(f.shell, `wfg --explain ${d.first}-${d.second}`);
    expect(explained[0]).toMatch(/demonstrates (mutual_exclusion|hold_and_wait|no_preemption|circular_wait)/);
    expect(expectError(f.shell, 'wfg --explain 7-8').topic).toBe('wfg');
    expect(expectError(f.shell, 'wfg --explain 7->8').topic).toBe('man');
    expect(expectError(f.shell, 'wfg --watch').topic).toBe('wfg');
  });

  it('bankers trace: one line per SafetyTraceStep using its explanation, and the matrices from the host (acceptance 14)', () => {
    const b = bankersKernel();
    const f = shellWith(['bankers'], b.kernel);
    const state = expectOk(f.shell, 'bankers --state');
    expect(state[0]).toBe('available: A=3 B=3 C=2');
    expect(state[1]).toMatch(/^PID\s+max A\s+max B\s+max C\s+alloc A/);
    expect(state).toHaveLength(2 + 5);
    const pid = b.pids[1] ?? asPid(0);
    const check = expectOk(f.shell, `bankers --check ${pid} A 1`);
    const result = b.kernel.evaluateBankers(pid, b.A, 1);
    expect(check[1], check.join('\n')).toBe('safe: yes');
    expect(check.slice(3)).toEqual(result.trace.map(step => step.explanation));
    expect(check.length - 3).toBe(result.trace.length);
    const sequence = expectOk(f.shell, 'bankers --sequence');
    expect(sequence).toEqual(['safe: yes', 'sequence: P3 P5 P2 P4 P6']);
    b.kernel.deadlockSubsystem.resources.grant(b.pids[0] ?? asPid(0), [[b.A, 3]]);
    expect(expectOk(f.shell, 'bankers --state')).not.toEqual(state);
    const error = expectError(f.shell, `bankers --check ${pid} Z 1`);
    expect(error.topic).toBe('bankers');
    expect(error.errno).toBe('ENOENT');
  });

  it('resources lists the live table and changes the strategy through exactly one dispatch', () => {
    const f = shellWith(['resources'], makeKernel({ deadlockStrategy: 'detect' }));
    const before = expectOk(f.shell, 'resources');
    f.kernel.declareResource({ id: asResourceId('gate_c'), displayName: 'gate', totalInstances: 2, preemptible: false });
    const after = expectOk(f.shell, 'resources --list');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('gate_c'))).toBe(true);
    expect(expectOk(f.shell, 'resources --strategy ignore')).toEqual(['deadlock strategy set to ignore']);
    expect(f.kernel.config.deadlockStrategy).toBe('ignore');
    expect(f.run.decisions).toHaveLength(1);
    expect(f.run.decisions[0]?.kind).toBe('set_deadlock_strategy');
    expect(expectError(f.shell, 'resources --strategy pray').topic).toBe('resources');
    expect(expectError(f.shell, 'resources --rank gate_c 1').topic).toBe('resources');
    expect(f.run.decisions).toHaveLength(1);
  });
});

/** A process that touches four pages in a loop, on eight frames, with demand paging live. */
function pagingKernel(frames = 8) {
  const kernel = makeKernel({ totalFrames: frames, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'io', 'storage', 'deadlock'] });
  const pid = kernel.spawn({ name: 'pager', priority: 1, arrival: 0, burst: 200, service: 200, pages: 4, referenceString: Array.from({ length: 200 }, (_, i) => i % 4) });
  return { kernel, pid };
}

describe('memory commands', () => {
  it('free reports live totals and, with -f, the shape of the free space', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['free'], kernel);
    const before = expectOk(f.shell, 'free');
    expect(before[0]).toBe('total      8 frames');
    kernel.run(20);
    const after = expectOk(f.shell, 'free -f');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('free') && !line.includes('8 frames'))).toBe(true);
    expect(after.some(line => /free runs/.test(line))).toBe(true);
    expect(expectOk(f.shell, 'free -h')[0]).toContain('KiB');
    expect(expectError(f.shell, 'free --shape').topic).toBe('free');
  });

  it('pagetable prints the live table of the running process, translates addresses and refuses bad pages', () => {
    const { kernel, pid } = pagingKernel();
    const f = shellWith(['pagetable'], kernel);
    expect(expectError(f.shell, 'pagetable').topic).toBe('pagetable');
    const before = expectOk(f.shell, `pagetable ${pid}`);
    expect(before[0]).toContain('0 resident');
    kernel.run(20);
    const after = expectOk(f.shell, `pagetable ${pid} --bits`);
    expect(after).not.toEqual(before);
    expect(after[1]).toMatch(/PAGE\s+FRAME\s+VALID\s+DIRTY\s+REF\s+SWAPPED\s+R\s+W\s+X\s+ACCESSES/);
    const translated = expectOk(f.shell, `pagetable ${pid} --translate 4300`);
    expect(translated.some(line => line.startsWith('page') && line.endsWith('1'))).toBe(true);
    expect(translated.some(line => line.startsWith('offset') && line.endsWith('204'))).toBe(true);
    expect(expectOk(f.shell, `pagetable ${pid} --entry 0`)).toHaveLength(3);
    expect(expectError(f.shell, `pagetable ${pid} --entry 9`).errno).toBe('EINVAL');
    expect(expectError(f.shell, 'pagetable 999').errno).toBe('ESRCH');
  });

  it('tlb reports the live hit rate and entries, flushes through the sink, and refuses --entries', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['tlb'], kernel);
    const before = expectOk(f.shell, 'tlb --stats');
    expect(before[0]).toBe('capacity       16');
    kernel.run(30);
    const after = expectOk(f.shell, 'tlb');
    expect(after).not.toEqual(before);
    expect(after.length).toBeGreaterThan(4);
    const flushed = expectOk(f.shell, 'tlb --flush');
    expect(flushed[0]).toMatch(/^TLB flushed by P\d+$/);
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'ioctl', pid: expect.any(Number), args: ['kernel', 'tlb_flush'] } }]);
    expect(expectOk(f.shell, 'tlb').some(line => line.startsWith('valid entries  0'))).toBe(true);
    expect(expectError(f.shell, 'tlb --entries 32').topic).toBe('tlb');
  });

  it('frag reports both fragmentation measures live and refuses replays', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['frag'], kernel);
    const before = expectOk(f.shell, 'frag');
    expect(before.some(line => line.startsWith('external'))).toBe(true);
    expect(before.some(line => line.startsWith('internal'))).toBe(true);
    kernel.run(20);
    expect(expectOk(f.shell, 'frag --external')).not.toEqual(before);
    expect(expectOk(f.shell, 'frag --internal')).toHaveLength(1);
    expect(expectError(f.shell, 'frag --compact').topic).toBe('frag');
  });

  it('vmstat reads the live fault counters and changes the policy through one dispatch', () => {
    const { kernel } = pagingKernel(2);
    const f = shellWith(['vmstat'], kernel);
    const before = expectOk(f.shell, 'vmstat');
    expect(before[0]).toBe('page faults          0');
    kernel.run(60);
    const after = expectOk(f.shell, 'vmstat --interval 60 --faults');
    expect(after).not.toEqual(before);
    expect(after.some(line => /^last 60 ticks: [1-9]\d* faults/.test(line))).toBe(true);
    expect(after.some(line => /^TICK\s+PID\s+PAGE\s+MAJOR/.test(line))).toBe(true);
    expect(expectOk(f.shell, 'vmstat --policy fifo')).toEqual(['replacement policy now fifo']);
    expect(f.run.decisions).toHaveLength(1);
    expect(f.sink.dispatched).toEqual([{ kind: 'set_replacement', id: 'fifo' }]);
    expect(expectError(f.shell, 'vmstat --policy magic').topic).toBe('vmstat');
    expect(expectError(f.shell, 'vmstat --interval 0').topic).toBe('vmstat');
  });

  it('ws reports live working sets against allocated frames and the budget', () => {
    const { kernel, pid } = pagingKernel();
    const f = shellWith(['ws'], kernel);
    const before = expectOk(f.shell, 'ws');
    expect(before[0]).toBe('window 10 ticks');
    kernel.run(20);
    const after = expectOk(f.shell, `ws ${pid} --budget`);
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('budget: working sets total'))).toBe(true);
    expect(expectError(f.shell, 'ws --window 5').topic).toBe('ws');
    expect(expectError(f.shell, 'ws 999').errno).toBe('ESRCH');
  });

  it('degree reads the live degree and sets it through exactly one dispatch', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['degree'], kernel);
    const before = expectOk(f.shell, 'degree');
    expect(before[0]).toBe('degree      8');
    expect(expectOk(f.shell, 'degree --set 2')).toEqual(['degree of multiprogramming set to 2']);
    expect(f.host.degree()).toBe(2);
    expect(f.run.decisions).toHaveLength(1);
    expect(f.run.policy.degreeOfMultiprogramming).toBe(2);
    expect(expectOk(f.shell, 'degree')).not.toEqual(before);
    expect(expectError(f.shell, 'degree --set 0').topic).toBe('degree');
    expect(expectError(f.shell, 'degree --set 99').topic).toBe('degree');
    expect(expectError(f.shell, 'degree --suspend 3').topic).toBe('degree');
    expect(f.run.decisions).toHaveLength(1);
  });

  it('belady is a definition without a handler until a leg supplies one', () => {
    const f = shellWith(['belady']);
    const error = expectError(f.shell, 'belady --policy fifo --frames 3');
    expect(error.topic).toBe('belady');
    expect(error.message).toContain('no handler');
  });
});


/** The opt-in paging storage fixture of tests/kernel/storage/costModel.test.ts: page faults become disk requests. */
function diskKernel() {
  const kernel = makeKernel({ totalFrames: 3, replacementPolicy: 'fifo', thrashingThreshold: 1e9,
    enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'storage', 'io'] },
  { majorFaultTicks: 3, tlbMissTicks: 1, tlbHitTicks: 1, thrashingCriticalDemandRatio: 1e9, thrashingSuspendInterval: 1000 });
  kernel.attachPagingStorage();
  const access = (page: number, write = false): Instruction => ({ kind: 'access', page: asPageId(page), write });
  const pid = kernel.spawn({ name: 'backed page reader', priority: 10, arrival: 0, burst: 100, service: 100, pages: 3 },
    { program: instructionProgram([access(0), access(1, true), access(2), access(0), { kind: 'compute' }]) });
  return { kernel, pid };
}

describe('storage commands', () => {
  it('iostat measures disk service from the ring and the live queue, and describes one device', () => {
    const { kernel } = diskKernel();
    const f = shellWith(['iostat'], kernel);
    const before = expectOk(f.shell, 'iostat');
    expect(before.some(line => /^served\s+0 in/.test(line))).toBe(true);
    runUntil(kernel, () => f.shell.rings.diskServed.length >= 2, 200);
    const after = expectOk(f.shell, 'iostat --variance');
    expect(after).not.toEqual(before);
    expect(after.some(line => /^served\s+[1-9]/.test(line))).toBe(true);
    expect(after.some(line => line.startsWith('wait variance'))).toBe(true);
    expect(expectOk(f.shell, 'iostat --interval 5').some(line => /in 5 ticks/.test(line))).toBe(true);
    const device = expectOk(f.shell, 'iostat --device disk0');
    expect(device[0]).toBe('device       disk0');
    const error = expectError(f.shell, 'iostat --device nvme9');
    expect(error.errno).toBe('ENOENT');
    expect(error.topic).toBe('iostat');
  });

  it('seekq lists the pending queue with ages, projects the path, and sets the policy through one dispatch', () => {
    const { kernel } = diskKernel();
    const f = shellWith(['seekq'], kernel);
    const before = expectOk(f.shell, 'seekq --path');
    expect(before[0]).toMatch(/^head at cylinder \d+ of 200, direction (up|down), policy look, 0 pending$/);
    expect(before.at(-1)).toMatch(/^path: /);
    kernel.run(2);
    const after = expectOk(f.shell, 'seekq --path');
    expect(after).not.toEqual(before);
    expect(expectOk(f.shell, 'seekq --policy sstf')).toEqual(['disk policy set to sstf']);
    expect(f.run.decisions).toHaveLength(1);
    expect(f.sink.dispatched).toEqual([{ kind: 'set_disk', id: 'sstf' }]);
    expect(expectError(f.shell, 'seekq --policy zigzag').topic).toBe('seekq');
    expect(expectError(f.shell, 'seekq --compare').topic).toBe('seekq');
    expect(f.run.decisions).toHaveLength(1);
  });

  it('raid reports the live array state and refuses reconfiguration', () => {
    const f = shellWith(['raid']);
    expect(expectOk(f.shell, 'raid')).toEqual(['no array configured']);
    const storage = f.kernel.storageSubsystem;
    const members = ['m0', 'm1', 'm2', 'm3'];
    for (const drive of [...members, 'spare0']) storage.ensureDrive(drive);
    const array = storage.registerRaid({ arrayId: 'array', level: 5, members, blocksPerMember: 16, spares: ['spare0'] });
    const healthy = expectOk(f.shell, 'raid --status');
    expect(healthy).toContain('status    healthy');
    array.failDisk(1);
    const degraded = expectOk(f.shell, 'raid');
    expect(degraded).not.toEqual(healthy);
    expect(degraded.some(line => line.startsWith('members') && line.includes('m1 FAILED'))).toBe(true);
    expect(expectError(f.shell, 'raid --level 6').topic).toBe('raid');
  });
});

describe('io commands', () => {
  it('iomode lists the live devices and changes a mode through one ioctl dispatch', () => {
    const f = shellWith(['iomode']);
    const before = expectOk(f.shell, 'iomode');
    expect(before.some(line => /^tty0\s/.test(line))).toBe(true);
    runningProcess(f.kernel);
    expect(expectOk(f.shell, 'iomode --device tty0 --set polling')).toEqual(['tty0 mode set to polling']);
    expect(f.kernel.ioSubsystem.mode('tty0' as DeviceId)).toBe('polling');
    expect(f.run.decisions).toHaveLength(1);
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'ioctl', pid: expect.any(Number), args: ['tty0', 'set_mode', 'polling'] } }]);
    expect(expectOk(f.shell, 'iomode --device tty0')).not.toEqual(before.filter(line => line.startsWith('DEVICE') || /^tty0\s/.test(line)));
    expect(expectOk(f.shell, 'iomode --device tty0')[1]).toMatch(/^tty0\s+\S+\s+polling\s+interrupt/);
    expect(expectError(f.shell, 'iomode --set dma').topic).toBe('iomode');
    expect(expectError(f.shell, 'iomode --device tty0 --set carrier').topic).toBe('iomode');
    expect(expectError(f.shell, 'iomode --device nope').errno).toBe('ENOENT');
    expect(expectError(f.shell, 'iomode --attach x block').topic).toBe('iomode');
  });

  it('irq counts interrupts from the ring and the pending lines from the view', () => {
    const f = shellWith(['irq']);
    const before = expectOk(f.shell, 'irq');
    expect(before[0]).toMatch(/^interrupts\s+0 recorded/);
    for (let count = 0; count < 3; count++) { f.kernel.ioSubsystem.interrupts.raise('timer' as DeviceId, { kind: 'timer' }); f.kernel.step(); }
    const after = expectOk(f.shell, 'irq --rate --handlers --latency');
    expect(after).not.toEqual(before);
    expect(after[0]).toMatch(/^interrupts\s+[1-9]\d* recorded/);
    expect(after.some(line => /^timer\s+\d+/.test(line))).toBe(true);
    expect(after.some(line => line.startsWith('handler cost'))).toBe(true);
    expect(after.some(line => line.startsWith('kernel I/O debt'))).toBe(true);
    expect(expectError(f.shell, 'irq --coalesce 4').topic).toBe('irq');
  });

  it('devstat shows device queues and configured buffers, and refuses the write flags', () => {
    const f = shellWith(['devstat']);
    const before = expectOk(f.shell, 'devstat');
    expect(before).toContain('0 buffers');
    const device = 'buffered timer' as DeviceId;
    f.kernel.ioSubsystem.registerTimerDevice({ id: device, latency: 20 });
    f.kernel.ioSubsystem.configureBuffer(device, { kind: 'double' }, 3, 3);
    f.kernel.ioSubsystem.submit({ kind: 'kernel', purpose: 'fixture' }, device);
    f.kernel.step();
    const after = expectOk(f.shell, 'devstat --copies');
    expect(after).not.toEqual(before);
    expect(after).toContain('1 buffers');
    expect(after.some(line => line.startsWith('buffered timer') && line.includes('double'))).toBe(true);
    expect(after.some(line => line.startsWith('copy ticks'))).toBe(true);
    expect(expectOk(f.shell, `devstat --device "${device}"`)[1]).toMatch(/^buffered timer/);
    expect(expectError(f.shell, 'devstat --async on').topic).toBe('devstat');
    expect(expectError(f.shell, 'devstat --device nope').errno).toBe('ENOENT');
  });
});

/** A formatted volume with one file, as tests/kernel/fs/inode.test.ts builds it at kernel level. */
function fsKernel() {
  const kernel = makeKernel({ enabledSubsystems: ['process', 'scheduler', 'storage', 'io', 'fs'] });
  const fs = kernel.fileSystemSubsystem;
  fs.format();
  runUntil(kernel, () => fs.mounted, 20_000);
  const inode = fs.createFile('/file');
  runUntil(kernel, () => !fs.busy, 20_000);
  return { kernel, fs, inode };
}

describe('filesystem commands', () => {
  it('inode prints the live record, its names and block walk, and refuses an unknown id', () => {
    const { kernel, fs, inode } = fsKernel();
    const f = shellWith(['inode'], kernel);
    const before = expectOk(f.shell, `inode ${inode} --links --blocks --method --walk`);
    expect(before[0]).toBe(`inode        ${inode}`);
    expect(before.some(line => line.startsWith('1 names: /file'))).toBe(true);
    expect(fs.hardLink(asPid(1), '/file', '/alias').ok).toBe(true);
    runUntil(kernel, () => fs.state().metadata.inodes.find(row => row.id === inode)?.linkCount === 2, 20_000);
    const after = expectOk(f.shell, `inode ${inode} --links`);
    expect(after).not.toEqual(before.slice(0, after.length));
    expect(after.some(line => line.startsWith('2 names:'))).toBe(true);
    expect(expectError(f.shell, 'inode 999').errno).toBe('ENOENT');
    expect(expectError(f.shell, 'inode').topic).toBe('inode');
    const disabled = shellWith(['inode'], makeKernel({ enabledSubsystems: ['process', 'scheduler'] }));
    expect(expectError(disabled.shell, `inode ${inode}`).message).toContain('not enabled');
  });

  it('journal prints the live log and refuses mode changes', () => {
    const { kernel, fs } = fsKernel();
    const f = shellWith(['journal'], kernel);
    const before = expectOk(f.shell, 'journal --tail 5');
    expect(before[0]).toMatch(/^mode\s+metadata$/);
    fs.createFile('/second');
    runUntil(kernel, () => !fs.busy, 20_000);
    const after = expectOk(f.shell, 'journal');
    expect(after).not.toEqual(before);
    expect(after.some(line => /^TICK\s+TX\s+PHASE\s+BLOCKS/.test(line))).toBe(true);
    expect(expectError(f.shell, 'journal --mode data').topic).toBe('journal');
    expect(expectError(f.shell, 'journal --tail none').topic).toBe('journal');
  });

  it('fsck reports mount state and inconsistencies live, and refuses repairs', () => {
    const { kernel, fs } = fsKernel();
    const f = shellWith(['fsck'], kernel);
    const before = expectOk(f.shell, 'fsck --check');
    expect(before[0]).toBe('mount state      mounted');
    fs.createFile('/third');
    runUntil(kernel, () => !fs.busy, 20_000);
    expect(expectOk(f.shell, 'fsck')).not.toEqual(before);
    expect(expectError(f.shell, 'fsck --repair').topic).toBe('fsck');
    expect(expectError(f.shell, 'fsck --from-journal').topic).toBe('fsck');
  });

  it('lsof lists live descriptors with their inodes, counts, and unlinked files', () => {
    const { kernel, fs, inode } = fsKernel();
    const f = shellWith(['lsof'], kernel);
    const before = expectOk(f.shell, 'lsof');
    const pid = kernel.spawn({ name: 'reader', priority: 1, arrival: kernel.tick + 1000, burst: 1, service: 1, pages: 1 });
    kernel.syscall({ pid, name: 'open', args: ['/file', 'r'] });
    runUntil(kernel, () => fs.state().processes.some(row => row.pid === pid && row.descriptors.length > 0), 20_000);
    const after = expectOk(f.shell, `lsof --pid ${pid}`);
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith(`P${pid}`) && line.includes(String(inode)) && line.includes('/file'))).toBe(true);
    expect(expectOk(f.shell, 'lsof --counts').some(line => line.startsWith(`P${pid}`))).toBe(true);
    expect(expectOk(f.shell, 'lsof --unlinked')).toHaveLength(1);
    expect(expectError(f.shell, 'lsof --pid many').topic).toBe('lsof');
    const disabled = shellWith(['lsof'], makeKernel({ enabledSubsystems: ['process', 'scheduler'] }));
    expect(expectOk(disabled.shell, 'lsof')[0]).toContain('file system not enabled');
  });

  it('mount lists the live volume and refuses namespaces and semantics', () => {
    const { kernel } = fsKernel();
    const f = shellWith(['mount'], kernel);
    const lines = expectOk(f.shell, 'mount --list');
    expect(lines[0]).toBe('state         mounted');
    expect(lines.some(line => line.startsWith('device'))).toBe(true);
    const disabled = shellWith(['mount'], makeKernel({ enabledSubsystems: ['process', 'scheduler'] }));
    expect(expectError(disabled.shell, 'mount').topic).toBe('mount');
    const unformatted = shellWith(['mount']);
    expect(expectOk(unformatted.shell, 'mount')[0]).toBe('state         unformatted');
    expect(expectError(f.shell, 'mount vol /mnt').topic).toBe('mount');
    expect(expectError(f.shell, 'mount --semantics session').topic).toBe('mount');
    expect(expectError(f.shell, 'mount --vfs').topic).toBe('mount');
  });
});

describe('security commands', () => {
  const user = 'domain:user' as DomainId;
  function secured() {
    const f = shellWith(['access', 'ring', 'audit', 'chmod']);
    f.kernel.securitySubsystem.defineDomain(user, 'User', 3);
    return f;
  }

  it('access prints the live matrix and one domain row, and refuses edits', () => {
    const f = secured();
    const before = expectOk(f.shell, 'access --matrix');
    expect(before[0]).toMatch(/^model acl/);
    f.kernel.securitySubsystem.matrix.grant(user, 'inode:4', ['read', 'execute']);
    const after = expectOk(f.shell, 'access');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith('domain:user') && line.includes('rx'))).toBe(true);
    const row = expectOk(f.shell, 'access --domain domain:user');
    expect(row[0]).toBe('domain:user (User, ring 3)');
    expect(row.some(line => line.startsWith('inode:4') && line.includes('rx'))).toBe(true);
    expect(expectError(f.shell, 'access --domain domain:nobody').errno).toBe('ENOENT');
    expect(expectError(f.shell, 'access --grant domain:user inode:4 write').topic).toBe('access');
  });

  it('ring lists live rings and the escalation attempts from the ring, and refuses --set', () => {
    const f = secured();
    const pid = runningProcess(f.kernel);
    const before = expectOk(f.shell, 'ring --list');
    f.kernel.securitySubsystem.bindProcess(pid, user);
    const after = expectOk(f.shell, 'ring');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.startsWith(`P${pid}`) && line.includes('domain:user') && /\s3\s/.test(line))).toBe(true);
    expect(f.kernel.syscall({ name: 'ioctl', pid, args: ['kernel', 'set_ring', 0] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    const attempts = expectOk(f.shell, 'ring --attempts');
    expect(attempts[0]).toMatch(/^[1-9]\d* ring transition attempts recorded$/);
    expect(attempts.some(line => line.includes(`P${pid}`) && /\s3\s+0\s+yes$/.test(line))).toBe(true);
    expect(expectError(f.shell, `ring --set ${pid} 0`).topic).toBe('ring');
  });

  it('audit replays denials with the cell that decided them and traces rights on an object', () => {
    const f = secured();
    const pid = runningProcess(f.kernel);
    const other = f.kernel.spawn({ name: 'other', priority: 5, arrival: 0, burst: 10, service: 10, pages: 0 }, { program: instructionProgram([{ kind: 'compute' }]) });
    f.kernel.securitySubsystem.bindProcess(pid, user);
    const before = expectOk(f.shell, 'audit');
    expect(before[0]).toBe('0 denials, 0 successful uses recorded');
    expect(f.kernel.syscall({ name: 'kill', pid, args: [other, 0] })).toMatchObject({ ok: false, errno: 'EPERM' });
    const after = expectOk(f.shell, 'audit --denied');
    expect(after).not.toEqual(before);
    expect(after[0]).toMatch(/^1 denials/);
    expect(after.some(line => line.includes(`process:${other}`) && line.includes('control') && line.endsWith('denied'))).toBe(true);
    const why = expectOk(f.shell, 'audit --why 1');
    expect(why[1]).toContain(`cell [domain:user, process:${other}] holds nothing`);
    f.kernel.securitySubsystem.matrix.grant(user, `process:${other}`, ['control']);
    const rights = expectOk(f.shell, `audit --rights process:${other}`);
    expect(rights[0]).toMatch(/^1 domains hold rights/);
    expect(expectOk(f.shell, 'audit --decisions 1')).toHaveLength(3);
    expect(expectError(f.shell, 'audit --why 9').topic).toBe('audit');
  });

  it('chmod maps the inode to its path and issues the chmod syscall through the sink', () => {
    const { kernel, inode } = fsKernel();
    const f = shellWith(['chmod'], kernel);
    const done = expectOk(f.shell, `chmod r-- ${inode}`);
    expect(done[0]).toMatch(new RegExp(`^chmod /file \\(inode ${inode}\\) r-- issued by P\\d+$`));
    expect(f.sink.dispatched).toEqual([{ kind: 'syscall', request: { name: 'chmod', pid: expect.any(Number), args: ['/file', 'r--'] } }]);
    expect(expectError(f.shell, 'chmod rwx 999').errno).toBe('ENOENT');
    expect(expectError(f.shell, `chmod 777 ${inode}`).topic).toBe('chmod');
    expect(expectError(f.shell, `chmod rwx ${inode} --sign`).topic).toBe('chmod');
    const disabled = shellWith(['chmod'], makeKernel({ enabledSubsystems: ['process', 'scheduler'] }));
    expect(expectError(disabled.shell, 'chmod rwx 2').message).toContain('not enabled');
  });
});

describe('decisions', () => {
  it('decision recorded: every policy command appends exactly one DecisionRecord (acceptance 8)', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['sched', 'nice', 'degree', 'resources', 'vmstat', 'iomode', 'seekq'], kernel);
    const pid = runningProcess(kernel);
    const lines = ['sched --policy rr --quantum 2', `nice -n 3 ${pid}`, 'degree --set 3', 'resources --strategy ignore', 'vmstat --policy clock', 'iomode --device tty0 --set polling', 'seekq --policy scan'];
    for (const [index, line] of lines.entries()) {
      expectOk(f.shell, line);
      expect(f.run.decisions, line).toHaveLength(index + 1);
    }
    expect(f.run.decisions.map(record => record.kind)).toEqual(['set_scheduler', 'syscall', 'set_degree', 'set_deadlock_strategy', 'set_replacement', 'syscall', 'set_disk']);
  });
});

describe('errors name topics (acceptance 11)', () => {
  it('every error this suite produced names a man topic that resolves', () => {
    expect(ERRORS.length).toBeGreaterThan(40);
    expectErrorsNameTopics();
  });
});


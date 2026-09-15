/**
 * KERNEL TRAIL: the process snapshot channel (amendment 14) and the completeness rule.
 *
 * Programs are serialised as their instruction streams and rebuilt through the
 * program constructor, so a restored kernel executes the same frozen instruction
 * objects a fresh one would. Every validation here is pure: it reads the
 * snapshot and the target kernel's tuning and touches no live table, so a
 * refused restore leaves the kernel exactly as it was.
 */
import { KernelConfigError } from './errors';
import { asPageId, asPid, asResourceId } from './types';
import type {
  DeviceId, FrameId, IpcSnapshot, JsonValue, KernelSnapshot, NamedProgramSnapshot, PageId, Pid,
  ProcessControlBlock, ProcessSnapshotState, ProgramSnapshot, SyscallName, SyscallResult, ThreadSnapshot, Tid,
} from './types';
import { instructionProgram, type Instruction, type Program } from './process/Program';
import type { SyncInstruction, SyncValue } from './sync/SyncSubsystem';
import type { KernelTuning } from './config';
import type { ProcessTableContribution, RawProcessWork } from './process/ProcessTable';
import type { ThreadContribution } from './process/threads';

const SYSCALL_NAMES: readonly SyscallName[] = [
  'fork', 'exec', 'exit', 'wait', 'kill', 'getpid', 'nice', 'mmap', 'munmap', 'brk',
  'open', 'close', 'read', 'write', 'seek', 'stat', 'unlink', 'mkdir',
  'sem_wait', 'sem_post', 'mutex_lock', 'mutex_unlock', 'request', 'release', 'ioctl', 'sync', 'chmod',
];
const PRIMITIVE_OPS = ['sem_wait', 'sem_post', 'mutex_lock', 'mutex_unlock', 'monitor_enter', 'monitor_exit',
  'rw_read_lock', 'rw_read_unlock', 'rw_write_lock', 'rw_write_unlock', 'barrier_wait'] as const;
const CONDITION_OPS = ['cond_wait', 'cond_signal', 'cond_broadcast'] as const;
const TESTS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const;

type JsonRecord = { readonly [key: string]: JsonValue };

function refuse(message: string): never { throw new KernelConfigError(`invalid process snapshot: ${message}`); }
function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function text(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') refuse(`${what} must be a string`);
  return value;
}
function count(value: JsonValue | undefined, what: string, minimum = 0): number {
  if (!integer(value, minimum)) refuse(`${what} must be an integer >= ${minimum}`);
  return value;
}
function flag(value: JsonValue | undefined, what: string): boolean {
  if (typeof value !== 'boolean') refuse(`${what} must be a boolean`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Program codec                                                        */
/* ------------------------------------------------------------------ */

function encodeSyncValue(value: SyncValue): JsonValue {
  return value.kind === 'literal' ? { kind: 'literal', value: value.value } : { kind: 'register', name: value.name };
}
function encodeSync(operation: SyncInstruction): JsonValue {
  switch (operation.op) {
    case 'load': return { op: 'load', cell: operation.cell, into: operation.into, rmw: operation.rmw };
    case 'store': return { op: 'store', cell: operation.cell, value: encodeSyncValue(operation.value), rmw: operation.rmw };
    case 'set': case 'add': return { op: operation.op, into: operation.into, value: encodeSyncValue(operation.value) };
    case 'branch': return { op: 'branch', left: encodeSyncValue(operation.left), test: operation.test, right: encodeSyncValue(operation.right), target: operation.target };
    case 'mfence': return { op: 'mfence' };
    case 'tas': return { op: 'tas', cell: operation.cell, into: operation.into };
    case 'cas': return { op: 'cas', cell: operation.cell, expected: encodeSyncValue(operation.expected), replacement: encodeSyncValue(operation.replacement), into: operation.into };
    case 'cond_wait': case 'cond_signal': case 'cond_broadcast':
      return { op: operation.op, monitor: operation.monitor, condition: operation.condition };
    case 'work': return { op: 'work', ticks: operation.ticks };
    case 'scenario': return { op: 'scenario', scenario: operation.scenario, step: operation.step };
    default: return { op: operation.op, resource: operation.resource };
  }
}
export function encodeInstruction(instruction: Instruction): JsonValue {
  switch (instruction.kind) {
    case 'compute': return { kind: 'compute' };
    case 'sync': return { kind: 'sync', operation: encodeSync(instruction.operation) };
    case 'access': return { kind: 'access', page: instruction.page, write: instruction.write };
    case 'syscall': return { kind: 'syscall', call: { name: instruction.call.name, pid: instruction.call.pid, args: [...instruction.call.args] } };
    case 'io': return { kind: 'io', device: instruction.device };
    case 'acquire': return { kind: 'acquire', resource: instruction.resource };
    case 'release': return { kind: 'release', resource: instruction.resource };
    case 'thread_create': return { kind: 'thread_create' };
    case 'thread_join': return { kind: 'thread_join', tid: instruction.tid };
  }
}
export function encodeProgram(program: Program): { readonly instructions: JsonValue; readonly referenceString: readonly PageId[] | null } {
  const instructions: JsonValue[] = [];
  for (let index = 0; index < program.length; index++) instructions.push(encodeInstruction(program.at(index)));
  return { instructions, referenceString: program.referenceString === null ? null : [...program.referenceString] };
}

function decodeSyncValue(value: JsonValue | undefined): SyncValue {
  if (!isRecord(value)) refuse('sync operand must be an object');
  if (value['kind'] === 'literal') {
    const literal = value['value'];
    if (typeof literal !== 'number' || !Number.isFinite(literal)) refuse('literal operand must be finite');
    return { kind: 'literal', value: literal };
  }
  if (value['kind'] === 'register') return { kind: 'register', name: text(value['name'], 'register name') };
  return refuse('unknown sync operand');
}
function decodeSync(value: JsonValue | undefined): SyncInstruction {
  if (!isRecord(value)) refuse('sync operation must be an object');
  const op = text(value['op'], 'sync op');
  switch (op) {
    case 'load': return { op, cell: text(value['cell'], 'cell'), into: text(value['into'], 'register'), rmw: flag(value['rmw'], 'rmw') };
    case 'store': return { op, cell: text(value['cell'], 'cell'), value: decodeSyncValue(value['value']), rmw: flag(value['rmw'], 'rmw') };
    case 'set': case 'add': return { op, into: text(value['into'], 'register'), value: decodeSyncValue(value['value']) };
    case 'branch': {
      const test = text(value['test'], 'branch test');
      if (!(TESTS as readonly string[]).includes(test)) refuse('unknown branch test');
      return { op, left: decodeSyncValue(value['left']), test: test as typeof TESTS[number], right: decodeSyncValue(value['right']), target: count(value['target'], 'branch target') };
    }
    case 'mfence': return { op };
    case 'tas': return { op, cell: text(value['cell'], 'cell'), into: text(value['into'], 'register') };
    case 'cas': return { op, cell: text(value['cell'], 'cell'), expected: decodeSyncValue(value['expected']), replacement: decodeSyncValue(value['replacement']), into: text(value['into'], 'register') };
    case 'work': return { op, ticks: count(value['ticks'], 'work ticks') };
    case 'scenario': return { op, scenario: text(value['scenario'], 'scenario'), step: count(value['step'], 'scenario step') };
    default:
      if ((CONDITION_OPS as readonly string[]).includes(op)) {
        return { op: op as typeof CONDITION_OPS[number], monitor: asResourceId(text(value['monitor'], 'monitor')), condition: text(value['condition'], 'condition') };
      }
      if ((PRIMITIVE_OPS as readonly string[]).includes(op)) {
        return { op: op as typeof PRIMITIVE_OPS[number], resource: asResourceId(text(value['resource'], 'resource')) };
      }
      return refuse(`unknown sync op ${op}`);
  }
}
function decodeArg(value: JsonValue): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return refuse('syscall argument must be a finite scalar');
}
export function decodeInstruction(value: JsonValue): Instruction {
  if (!isRecord(value)) refuse('instruction must be an object');
  const kind = text(value['kind'], 'instruction kind');
  switch (kind) {
    case 'compute': case 'thread_create': return { kind };
    case 'sync': return { kind, operation: decodeSync(value['operation']) };
    case 'access': return { kind, page: asPageId(count(value['page'], 'access page')), write: flag(value['write'], 'access write') };
    case 'syscall': {
      const call = value['call'];
      if (!isRecord(call)) refuse('syscall instruction needs a call');
      const name = text(call['name'], 'syscall name');
      if (!SYSCALL_NAMES.includes(name as SyscallName)) refuse(`unknown syscall ${name}`);
      const args = call['args'];
      if (!Array.isArray(args)) refuse('syscall args must be an array');
      return { kind, call: { name: name as SyscallName, pid: asPid(count(call['pid'], 'syscall pid')), args: args.map(decodeArg) } };
    }
    case 'io': return { kind, device: text(value['device'], 'device') as DeviceId };
    case 'acquire': case 'release': return { kind, resource: asResourceId(text(value['resource'], 'resource')) };
    case 'thread_join': return { kind, tid: count(value['tid'], 'joined tid', 1) as Tid };
    default: return refuse(`unknown instruction kind ${kind}`);
  }
}
export function decodeProgram(instructions: JsonValue, referenceString: readonly PageId[] | null): Program {
  if (!Array.isArray(instructions)) refuse('program instructions must be an array');
  if (referenceString !== null && referenceString.some(page => !integer(page))) refuse('reference string must hold page numbers');
  return instructionProgram(instructions.map(decodeInstruction), referenceString === null ? null : referenceString.map(page => asPageId(page)));
}

/* ------------------------------------------------------------------ */
/* Building the slot                                                    */
/* ------------------------------------------------------------------ */

export interface ProcessSnapshotSource {
  readonly programs: ReadonlyMap<Pid, Program>;
  readonly namedPrograms: ReadonlyMap<string, Program>;
  /** Every process the shared table exports, ascending, idle excluded. */
  readonly processes: readonly Readonly<ProcessControlBlock>[];
  readonly raw: ReadonlyMap<Pid, RawProcessWork>;
  readonly table: ProcessTableContribution;
  readonly threads: ThreadContribution;
  readonly lifecycle: { readonly cowRefCounts: readonly (readonly [FrameId, number])[]; readonly pendingChildReturns: readonly (readonly [Pid, number])[] };
  readonly ipc: IpcSnapshot;
  readonly burstSizes: ReadonlyMap<Pid, number>;
  readonly copyDebts: ReadonlyMap<Pid, number>;
  readonly syscallResults: ReadonlyMap<Pid, SyscallResult>;
  readonly nextAddressSpace: number;
  readonly tuning: KernelTuning;
}

const byKey = <T>(a: readonly [number, T], b: readonly [number, T]): number => a[0] - b[0];
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function tuningJson(tuning: KernelTuning): JsonValue {
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(tuning).sort(byText)) {
    const value: unknown = Reflect.get(tuning, key);
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else refuse(`tuning key ${key} is not plain data`);
  }
  return result;
}

export function buildProcessState(source: ProcessSnapshotSource): ProcessSnapshotState {
  const pcbs = new Map(source.processes.map(pcb => [pcb.pid, pcb] as const));
  const names = [...source.namedPrograms].sort(([a], [b]) => byText(a, b));
  const pidsAscending = [...source.programs.keys()].sort((a, b) => a - b);
  // Programs are immutable, so two that encode identically are the same program.
  // ProgramSnapshot.name and namedPrograms[].pid compare encodings rather than
  // object identity (pre-flight ruling): a forked child shares its parent's
  // program object, and a restore cannot know which pids shared one. Do not
  // reintroduce identity here.
  const keys = new Map<Program, string>();
  const keyOf = (program: Program): string => {
    let key = keys.get(program);
    if (key === undefined) { key = JSON.stringify(encodeProgram(program)); keys.set(program, key); }
    return key;
  };
  const nameOf = (program: Program): string | undefined => names.find(([, candidate]) => keyOf(candidate) === keyOf(program))?.[0];
  const pidOf = (program: Program): Pid | null => pidsAscending.find(pid => { const own = source.programs.get(pid); return own !== undefined && keyOf(own) === keyOf(program); }) ?? null;
  const lowestPc = (pid: Pid): number => {
    const owned = source.threads.threads.filter(thread => thread.pid === pid && thread.state !== 'terminated');
    return owned.length === 0 ? 0 : owned[0]?.programCounter ?? 0;
  };
  const programs: ProgramSnapshot[] = pidsAscending.map(pid => {
    const program = source.programs.get(pid);
    if (program === undefined) refuse('program vanished while saving');
    const encoded = encodeProgram(program);
    return { pid, name: nameOf(program) ?? pcbs.get(pid)?.name ?? '', instructions: encoded.instructions, programCounter: lowestPc(pid),
      repeating: false, referenceString: encoded.referenceString, serialFraction: source.raw.get(pid)?.serialFraction ?? source.tuning.defaultSerialFraction };
  });
  const namedPrograms: NamedProgramSnapshot[] = names.map(([name, program]) => {
    const encoded = encodeProgram(program);
    return { name, pid: pidOf(program), instructions: encoded.instructions, referenceString: encoded.referenceString };
  });
  const copyDebts = [...source.copyDebts].sort(byKey).map(([pid, debt]) => [pid, debt] as const);
  return {
    version: 1,
    programs, namedPrograms,
    threads: source.threads.threads,
    rawWork: source.table.rawWork, rawBursts: source.table.rawBursts,
    threadAccounting: source.threads.threadAccounting, deliveryCursors: source.threads.deliveryCursors,
    burstSizes: [...source.burstSizes].sort(byKey).map(([pid, burst]) => [pid, burst] as const),
    lwpBindings: source.threads.lwpBindings,
    counters: { nextPid: source.table.nextPid, nextTid: source.threads.nextTid, nextAddressSpace: source.nextAddressSpace },
    pendingChildReturns: source.lifecycle.pendingChildReturns,
    cowRefCounts: source.lifecycle.cowRefCounts,
    copyDebts,
    syscallResults: [...source.syscallResults].sort(byKey).map(([pid, result]) => [pid, { ...result }] as const),
    createdEvents: source.table.createdEvents,
    ipc: source.ipc,
    tuning: tuningJson(source.tuning),
    executionDebt: copyDebts.reduce((total, [, debt]) => total + debt, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Validating before any mutation                                       */
/* ------------------------------------------------------------------ */

export interface ValidatedProcessState {
  readonly state: ProcessSnapshotState;
  readonly programs: ReadonlyMap<Pid, Program>;
  readonly namedPrograms: ReadonlyMap<string, Program>;
  readonly raw: readonly { readonly pid: Pid; readonly rawBurst: number; readonly rawService: number; readonly serialFraction: number }[];
}

function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameJson(value, b[index] ?? null));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a).sort(byText); const other = Object.keys(b).sort(byText);
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameJson(a[key] ?? null, b[key] ?? null));
}

function ascendingPids<T extends readonly [number, unknown]>(rows: readonly T[], what: string): void {
  for (let index = 1; index < rows.length; index++) {
    if ((rows[index]?.[0] ?? 0) <= (rows[index - 1]?.[0] ?? 0)) refuse(`${what} must ascend by pid`);
  }
}

/**
 * Check the process contribution against the shared tables of the same snapshot
 * and the target kernel's tuning, decoding every program. Pure.
 */
export function validateProcessState(snapshot: KernelSnapshot, tuning: KernelTuning): ValidatedProcessState {
  const state = snapshot.subsystems?.process;
  if (state === undefined) refuse('missing process contribution');
  if (state.version !== 1) refuse(`unsupported process contribution version ${String(state.version)}`);
  if (!sameJson(state.tuning, tuningJson(tuning))) refuse('snapshot tuning differs from this kernel');
  const pcbs = snapshot.processes;
  const pids = new Set<Pid>();
  let highestPid = 0, highestSpace = 1;
  for (const pcb of pcbs) {
    if (pcb.pid < 1 || pids.has(pcb.pid)) refuse('shared process table has a duplicate or idle entry');
    pids.add(pcb.pid); highestPid = Math.max(highestPid, pcb.pid); highestSpace = Math.max(highestSpace, pcb.addressSpaceId);
  }
  const programs = new Map<Pid, Program>();
  for (let index = 0; index < state.programs.length; index++) {
    const row = state.programs[index];
    if (row === undefined) continue;
    if (!pids.has(row.pid) || programs.has(row.pid)) refuse(`program for unknown or duplicate pid ${row.pid}`);
    if (index > 0 && row.pid <= (state.programs[index - 1]?.pid ?? 0)) refuse('programs must ascend by pid');
    if (!(row.serialFraction >= 0 && row.serialFraction <= 1)) refuse(`serial fraction for pid ${row.pid}`);
    programs.set(row.pid, decodeProgram(row.instructions, row.referenceString));
  }
  for (const pid of pids) if (!programs.has(pid)) refuse(`process ${pid} has no program`);
  const namedPrograms = new Map<string, Program>();
  for (let index = 0; index < state.namedPrograms.length; index++) {
    const row = state.namedPrograms[index];
    if (row === undefined) continue;
    if (namedPrograms.has(row.name) || row.name.length === 0) refuse(`named program ${row.name}`);
    if (index > 0 && byText(row.name, state.namedPrograms[index - 1]?.name ?? '') <= 0) refuse('named programs must ascend by name');
    const linked = row.pid === null ? undefined : programs.get(row.pid);
    if (row.pid !== null && linked === undefined) refuse(`named program ${row.name} links to an unknown pid`);
    namedPrograms.set(row.name, linked ?? decodeProgram(row.instructions, row.referenceString));
  }
  const tids = new Set<number>();
  let highestTid = 0;
  for (const thread of state.threads as readonly ThreadSnapshot[]) {
    if (tids.has(thread.tid) || !pids.has(thread.pid)) refuse(`thread ${thread.tid}`);
    tids.add(thread.tid); highestTid = Math.max(highestTid, thread.tid);
  }
  for (const pcb of pcbs) for (const tid of pcb.threads) {
    if (!state.threads.some(thread => thread.tid === tid && thread.pid === pcb.pid)) refuse(`process ${pcb.pid} thread ${tid} is missing`);
  }
  ascendingPids(state.rawWork, 'raw work'); ascendingPids(state.rawBursts, 'raw bursts');
  if (state.rawWork.length !== state.rawBursts.length || state.rawWork.some(([pid], index) => state.rawBursts[index]?.[0] !== pid)) refuse('raw work and raw bursts disagree');
  for (const [pid, service] of state.rawWork) if (!pids.has(pid) || !integer(service)) refuse(`raw work for pid ${pid}`);
  for (const [, burst] of state.rawBursts) if (!integer(burst)) refuse('raw burst');
  for (const pid of pids) if (!state.rawWork.some(([candidate]) => candidate === pid)) refuse(`process ${pid} has no raw work`);
  ascendingPids(state.burstSizes, 'burst sizes'); ascendingPids(state.copyDebts, 'copy debts'); ascendingPids(state.syscallResults, 'syscall results');
  for (const [pid, burst] of state.burstSizes) if (!pids.has(pid) || !integer(burst, 1)) refuse(`burst size for pid ${pid}`);
  for (const [pid, debt] of state.copyDebts) if (!pids.has(pid) || !integer(debt)) refuse(`copy debt for pid ${pid}`);
  for (const [pid, result] of state.syscallResults) {
    if (!pids.has(pid) || result === null || typeof result !== 'object') refuse(`syscall result for pid ${pid}`);
    if (result.ok ? !(result.value === null || ['string', 'number', 'boolean'].includes(typeof result.value)) : typeof result.errno !== 'string' || typeof result.message !== 'string') refuse(`syscall result shape for pid ${pid}`);
  }
  if (state.createdEvents.some((pid, index) => !pids.has(pid) || (index > 0 && pid <= (state.createdEvents[index - 1] ?? 0)))) refuse('created events');
  const debtSum = state.copyDebts.reduce((total, [, debt]) => total + debt, 0);
  if (state.executionDebt !== debtSum) refuse('execution debt disagrees with copy debts');
  for (const region of state.ipc.sharedRegions) {
    highestSpace = Math.max(highestSpace, region.space, ...region.attachments.map(row => row.space));
    for (const row of region.attachments) if (!pids.has(row.pid)) refuse(`region ${region.id} attacher ${row.pid}`);
  }
  for (const box of state.ipc.mailboxes) for (const pid of [...box.sendWaiters, ...box.recvWaiters]) if (!pids.has(pid)) refuse(`mailbox ${box.id} waiter ${pid}`);
  if (!integer(state.counters.nextPid, highestPid + 1)) refuse('next pid would reissue a live pid');
  if (!integer(state.counters.nextTid, highestTid + 1)) refuse('next tid would reissue a live tid');
  if (!integer(state.counters.nextAddressSpace, highestSpace + 1)) refuse('next address space would reissue a live space');
  const raw = state.rawWork.map(([pid, rawService], index) => ({ pid, rawService, rawBurst: state.rawBursts[index]?.[1] ?? 0,
    serialFraction: state.programs.find(row => row.pid === pid)?.serialFraction ?? tuning.defaultSerialFraction }));
  return { state, programs, namedPrograms, raw };
}

/**
 * The kernel holds state the shared tables cannot express once a user process
 * has existed, a program is registered, IPC objects exist, or the tuning in
 * force differs from the defaults (tuning changes computed service).
 */
export function hasWorkloadState(view: { readonly nextPid: number; readonly namedPrograms: number; readonly ipcHasState: boolean; readonly customTuning: boolean }): boolean {
  return view.nextPid > 2 || view.namedPrograms > 0 || view.ipcHasState || view.customTuning;
}

/**
 * The completeness rule of sim spec 1.5: a snapshot weaker than the state it is
 * restored into is refused, and a snapshot that claims to be full must carry the
 * process contribution. Pure; throws before any mutation.
 */
export function checkCompleteness(snapshot: KernelSnapshot, targetHasWorkload: boolean): 'init_only' | 'full' {
  const declared = snapshot.completeness ?? 'init_only';
  if (declared !== 'init_only' && declared !== 'full') throw new KernelConfigError(`unknown snapshot completeness ${String(declared)}`);
  if (declared === 'init_only') {
    if (targetHasWorkload) throw new KernelConfigError('restore refused: an init-only snapshot cannot replace a kernel that has run a workload; save the workload with completeness full');
    if (snapshot.subsystems?.process !== undefined) throw new KernelConfigError('restore refused: an init-only snapshot carries a process contribution');
    return declared;
  }
  if (snapshot.subsystems === undefined) throw new KernelConfigError('restore refused: a full snapshot has no subsystems channel');
  if (snapshot.subsystems.process === undefined) throw new KernelConfigError('restore refused: a full snapshot has no process contribution');
  return declared;
}

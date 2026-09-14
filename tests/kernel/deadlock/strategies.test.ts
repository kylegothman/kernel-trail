import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KernelImpl } from '@kernel/Kernel';
import type { KernelOptions } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import { asResourceId } from '@kernel/types';
import type { KernelConfig, KernelEvent, Pid, ResourceId, SyscallResult } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const A = asResourceId('A'), B = asResourceId('B');
type Strategy = KernelConfig['deadlockStrategy'];
type Stage = 'first' | 'second' | 'full' | 'wait_first' | 'wait_second' | 'wait_full' | 'retry_release' | 'work' | 'release_first' | 'release_second' | 'exit' | 'done';
interface Client {
  readonly pid: Pid;
  readonly first: ResourceId;
  readonly second: ResourceId;
  stage: Stage;
  usefulWork: number;
  retries: number;
}

function kernelFor(strategy: Strategy, options: KernelOptions = {}): KernelImpl {
  return new KernelImpl({ ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: strategy,
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1, agingInterval: 0,
      starvationThreshold: 10_000, starvationFatalThreshold: 20_000 },
    enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
  }, { threadCreateTicks: 0, contextSwitchTicks: 0, ...options });
}

function declarePair(kernel: KernelImpl): void {
  for (const id of [A, B]) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
}

function spawnClient(kernel: KernelImpl, name: string): Pid {
  return kernel.spawn({ name, priority: 4, arrival: 0, burst: 20_000, service: 20_000, pages: 0 },
    { program: instructionProgram([]) });
}

function request(kernel: KernelImpl, pid: Pid, resources: readonly ResourceId[]): SyscallResult {
  return kernel.syscall({ pid, name: 'request', args: resources.flatMap(resource => [resource, 1]) });
}

function release(kernel: KernelImpl, pid: Pid, resources: readonly ResourceId[]): SyscallResult {
  return kernel.syscall({ pid, name: 'release', args: resources.flatMap(resource => [resource, 1]) });
}

function mustSucceed(result: SyscallResult): void { expect(result.ok).toBe(true); }

function executionHoldings(kernel: KernelImpl): ReadonlyMap<Pid, readonly ResourceId[]> {
  const holdings = new Map<Pid, readonly ResourceId[]>();
  kernel.onPhase(phase => {
    if (phase !== 8) return;
    holdings.clear();
    for (const process of kernel.processes) {
      if (process.state === 'running') holdings.set(process.pid, [...process.heldResources]);
    }
  });
  return holdings;
}

/** One protocol action follows each scheduled compute tick; Program.at has no effects. */
function advance(kernel: KernelImpl, client: Client, repeat: boolean, executedHolding: ReadonlyMap<Pid, readonly ResourceId[]>): void {
  const pcb = kernel.process(client.pid);
  if (pcb?.state !== 'running') return;
  const holds = (id: ResourceId): boolean => pcb.heldResources.includes(id);
  if (client.stage === 'wait_first') {
    expect(holds(client.first)).toBe(true); client.stage = 'second';
  } else if (client.stage === 'wait_second' || client.stage === 'wait_full') {
    expect(holds(A) && holds(B)).toBe(true); client.stage = 'work';
  }
  if (client.stage === 'first' || client.stage === 'second' || client.stage === 'full') {
    const stage = client.stage;
    const resources = stage === 'first' ? [client.first] : stage === 'second' ? [client.second] : [A, B];
    const result = request(kernel, client.pid, resources);
    if (result.ok) client.stage = stage === 'first' ? 'second' : 'work';
    else if (result.errno === 'EAGAIN') client.stage = stage === 'first' ? 'wait_first' : stage === 'second' ? 'wait_second' : 'wait_full';
    else {
      expect(result.errno).toBe('EDEADLK');
      client.retries += 1; client.stage = pcb.heldResources.length === 0 ? 'full' : 'retry_release';
    }
    return;
  }
  if (client.stage === 'retry_release') {
    mustSucceed(release(kernel, client.pid, [...pcb.heldResources])); client.stage = 'full'; return;
  }
  if (client.stage === 'work') {
    expect(holds(A) && holds(B)).toBe(true);
    // A wakeup counts work only when the reservation preceded this tick's execution.
    expect(executedHolding.get(client.pid)).toEqual(expect.arrayContaining([A, B]));
    client.usefulWork += 1;
    if (client.usefulWork % 8 === 0) client.stage = 'release_first';
    return;
  }
  if (client.stage === 'release_first') {
    mustSucceed(release(kernel, client.pid, [client.first])); client.stage = 'release_second'; return;
  }
  if (client.stage === 'release_second') {
    mustSucceed(release(kernel, client.pid, [client.second])); client.stage = repeat ? 'first' : 'exit'; return;
  }
  if (client.stage === 'exit') {
    mustSucceed(kernel.syscall({ pid: client.pid, name: 'exit', args: [0] })); client.stage = 'done';
  }
}

export function strategyFixture(strategy: Strategy, horizon = 1000, repeat = false) {
  const kernel = kernelFor(strategy); declarePair(kernel);
  const first = spawnClient(kernel, 'A then B'), second = spawnClient(kernel, 'B then A');
  for (const pid of [first, second]) kernel.declareClaims(pid, [[A, 1], [B, 1]]);
  const clients: Client[] = [
    { pid: first, first: A, second: B, stage: 'first', usefulWork: 0, retries: 0 },
    { pid: second, first: B, second: A, stage: 'first', usefulWork: 0, retries: 0 },
  ];
  const events: KernelEvent[] = []; kernel.events.onAny(event => { events.push(event); });
  const executedHolding = executionHoldings(kernel);
  while (kernel.tick < horizon) {
    kernel.step();
    for (const client of clients) advance(kernel, client, repeat, executedHolding);
    if (strategy === 'prevent') expect(kernel.detectDeadlock()).toBeNull();
    if (!repeat && clients.every(client => ['zombie', 'terminated'].includes(kernel.process(client.pid)?.state ?? ''))) break;
  }
  const unfinished = clients.filter(client => !['zombie', 'terminated'].includes(kernel.process(client.pid)?.state ?? '')).map(client => client.pid);
  return { kernel, clients, events, row: { strategy, ...kernel.deadlockSubsystem.strategyReport(), unfinished: unfinished.length } };
}

export function contentionFixture(preventionMode: 'ordering' | 'all_or_nothing') {
  const kernel = kernelFor('prevent', { preventionMode }); declarePair(kernel);
  const holder = spawnClient(kernel, 'B for forty useful ticks'), contender = spawnClient(kernel, 'A and B');
  kernel.declareClaims(holder, [[B, 1]]); kernel.declareClaims(contender, [[A, 1], [B, 1]]);
  let holderStage: 'acquire' | 'work' | 'release' | 'exit' | 'done' = 'acquire';
  let holderWork = 0;
  const client: Client = { pid: contender, first: A, second: B,
    stage: preventionMode === 'all_or_nothing' ? 'full' : 'first', usefulWork: 0, retries: 0 };
  let observedContention = false;
  const executedHolding = executionHoldings(kernel);
  while (kernel.tick < 1000) {
    kernel.step();
    if (kernel.process(holder)?.state === 'running') {
      if (holderStage === 'acquire') { mustSucceed(request(kernel, holder, [B])); holderStage = 'work'; }
      else if (holderStage === 'work') {
        expect(executedHolding.get(holder)).toContain(B);
        holderWork += 1; if (holderWork === 40) holderStage = 'release';
      }
      else if (holderStage === 'release') { mustSucceed(release(kernel, holder, [B])); holderStage = 'exit'; }
      else if (holderStage === 'exit') { mustSucceed(kernel.syscall({ pid: holder, name: 'exit', args: [0] })); holderStage = 'done'; }
    }
    advance(kernel, client, false, executedHolding);
    if (kernel.process(contender)?.state === 'waiting' && kernel.process(holder)?.heldResources.includes(B)) {
      observedContention = true;
      expect(kernel.process(contender)?.heldResources).toEqual(preventionMode === 'ordering' ? [A] : []);
    }
    if (holderStage === 'done' && client.stage === 'done') break;
  }
  expect(observedContention).toBe(true); expect(holderWork).toBe(40); expect(client.usefulWork).toBe(8);
  expect(holderStage).toBe('done'); expect(client.stage).toBe('done');
  return { kernel, row: { preventionMode, ...kernel.deadlockSubsystem.strategyReport() } };
}

describe('the four deadlock strategies', () => {
  it('uses the approved two-client protocol and records each strategy including unfinished runs', () => {
    const results = (['ignore', 'detect', 'avoid', 'prevent'] as const).map(strategy => strategyFixture(strategy));
    const [ignored, detected, avoided, prevented] = results;
    if (ignored === undefined || detected === undefined || avoided === undefined || prevented === undefined) throw new Error('missing strategy fixture');
    expect(ignored.row).toMatchObject({ deadlocks: 0, processesLost: 0, totalTicks: 1000, unfinished: 2 });
    expect(ignored.events.filter(event => event.type === 'deadlock.detected')).toEqual([]);
    expect(ignored.clients.every(client => ignored.kernel.process(client.pid)?.state === 'waiting')).toBe(true);
    expect(detected.row).toMatchObject({ deadlocks: 1, processesLost: 1, unfinished: 0 });
    expect(detected.events.some(event => event.type === 'deadlock.detected')).toBe(true);
    expect(detected.events.some(event => event.type === 'deadlock.resolved')).toBe(true);
    expect(avoided.row).toMatchObject({ deadlocks: 0, processesLost: 0, unfinished: 0 });
    expect(avoided.events.some(event => event.type === 'resource.denied' && event.reason === 'unsafe')).toBe(true);
    expect(prevented.row).toMatchObject({ deadlocks: 0, processesLost: 0, unfinished: 0 });
    expect(prevented.clients.reduce((sum, client) => sum + client.retries, 0)).toBeGreaterThan(0);
    for (const result of [avoided, prevented]) expect(result.clients.map(client => client.usefulWork)).toEqual([8, 8]);
    expect(new Set(results.map(result => JSON.stringify(result.row))).size).toBe(4);
    expect(results.map(result => result.row)).toEqual([
      { strategy: 'ignore', deadlocks: 0, processesLost: 0, averageUtilisation: 1997 / 2000, totalTicks: 1000, unfinished: 2 },
      { strategy: 'detect', deadlocks: 1, processesLost: 1, averageUtilisation: 56 / 62, totalTicks: 31, unfinished: 0 },
      { strategy: 'avoid', deadlocks: 0, processesLost: 0, averageUtilisation: 43 / 52, totalTicks: 26, unfinished: 0 },
      { strategy: 'prevent', deadlocks: 0, processesLost: 0, averageUtilisation: 49 / 56, totalTicks: 28, unfinished: 0 },
    ]);
    expect(results.map(result => result.kernel.deadlockSubsystem.saveState().deadlock?.payload.statistics)).toEqual([
      { deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 1997, capacityInstanceTicks: 2000, totalTicks: 1000, detectionLatencyTicks: 0, detectionSamples: 0 },
      { deadlocks: 1, processesLost: 1, occupiedInstanceTicks: 56, capacityInstanceTicks: 62, totalTicks: 31, detectionLatencyTicks: 15, detectionSamples: 1 },
      { deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 43, capacityInstanceTicks: 52, totalTicks: 26, detectionLatencyTicks: 0, detectionSamples: 0 },
      { deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 49, capacityInstanceTicks: 56, totalTicks: 28, detectionLatencyTicks: 0, detectionSamples: 0 },
    ]);
  });

  it('all-or-nothing leaves A unused while the other process holds B for forty work ticks', () => {
    const ordering = contentionFixture('ordering'), atomic = contentionFixture('all_or_nothing');
    expect(ordering.row.deadlocks).toBe(0); expect(atomic.row.deadlocks).toBe(0);
    expect(atomic.row.averageUtilisation).toBeLessThan(ordering.row.averageUtilisation);
    expect([ordering.row, atomic.row]).toEqual([
      { preventionMode: 'ordering', deadlocks: 0, processesLost: 0, averageUtilisation: 106 / 112, totalTicks: 56 },
      { preventionMode: 'all_or_nothing', deadlocks: 0, processesLost: 0, averageUtilisation: 63 / 110, totalTicks: 55 },
    ]);
    expect([ordering, atomic].map(result => result.kernel.deadlockSubsystem.saveState().deadlock?.payload.statistics)).toEqual([
      { deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 106, capacityInstanceTicks: 112, totalTicks: 56, detectionLatencyTicks: 0, detectionSamples: 0 },
      { deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 63, capacityInstanceTicks: 110, totalTicks: 55, detectionLatencyTicks: 0, detectionSamples: 0 },
    ]);
  });

  it('keeps rank-governed requests acyclic for 5000 ticks of repeated opposite-order attempts', () => {
    const result = strategyFixture('prevent', 5000, true);
    expect(result.row.deadlocks).toBe(0); expect(result.row.processesLost).toBe(0);
    expect(result.clients.every(client => client.usefulWork > 8)).toBe(true);
    expect(result.events.filter(event => event.type === 'deadlock.detected')).toEqual([]);
  });

  it('DL-PREVENT-1 rejects rank three to rank one without blocking or enqueueing', () => {
    const kernel = kernelFor('prevent');
    const ids = ['rank-one', 'rank-two', 'rank-three'].map(asResourceId);
    for (const id of ids) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
    const low = ids[0], high = ids[2]; if (low === undefined || high === undefined) throw new Error('missing ranked fixture');
    const pid = spawnClient(kernel, 'rank violation'); kernel.step();
    mustSucceed(request(kernel, pid, [high]));
    const before = kernel.deadlockSubsystem.saveState();
    const events: KernelEvent[] = []; kernel.events.onAny(event => { events.push(event); });
    expect(request(kernel, pid, [low])).toMatchObject({ ok: false, errno: 'EDEADLK' });
    expect(kernel.process(pid)).toMatchObject({ state: 'running', blockedOn: null, requestedResources: [], heldResources: [high] });
    expect(kernel.deadlockSubsystem.saveState()).toEqual(before);
    expect(events.filter(event => event.type === 'resource.requested' || event.type === 'sync.blocked')).toEqual([]);
  });

  it('applies declaration ranks to mutex and generic counting semaphore acquisition through the callback', () => {
    const kernel = kernelFor('prevent');
    const semaphore = asResourceId('early-semaphore'), mutex = asResourceId('middle-mutex'), resource = asResourceId('late-resource');
    kernel.syncSubsystem.createSemaphore(semaphore, 3); kernel.syncSubsystem.createMutex(mutex);
    kernel.declareResource({ id: resource, displayName: resource, totalInstances: 1, preemptible: false });
    const pid = spawnClient(kernel, 'mixed ranks'); kernel.step(); mustSucceed(request(kernel, pid, [resource]));
    const before = kernel.syncSubsystem.saveState();
    expect(kernel.syscall({ pid, name: 'sem_wait', args: [semaphore] })).toMatchObject({ ok: false, errno: 'EDEADLK' });
    expect(kernel.syscall({ pid, name: 'mutex_lock', args: [mutex] })).toMatchObject({ ok: false, errno: 'EDEADLK' });
    expect(kernel.syncSubsystem.saveState()).toEqual(before);
    expect(kernel.process(pid)?.state).toBe('running');
  });

  it('rejects cross-namespace declarations and invalid strategy or prevention modes', () => {
    const kernel = kernelFor('ignore');
    const sync = asResourceId('sync-id'), mailbox = asResourceId('mailbox-id'), resource = asResourceId('resource-id');
    kernel.syncSubsystem.createMutex(sync); kernel.ipc.createMailbox(mailbox, 0);
    for (const id of [sync, mailbox, asResourceId('mbox:mailbox-id:send')]) {
      expect(() => kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false })).toThrow();
    }
    kernel.declareResource({ id: resource, displayName: resource, totalInstances: 1, preemptible: false });
    expect(() => kernel.syncSubsystem.createMutex(resource)).toThrow();
    expect(() => kernel.setDeadlockStrategy('unknown' as Strategy)).toThrow();
    expect(kernel.config.deadlockStrategy).toBe('ignore');
    expect(() => kernelFor('prevent', { preventionMode: 'unknown' as 'ordering' })).toThrow();
  });

  it('requires consistent claims when switching into avoidance and terminates over-claim requests', () => {
    const kernel = kernelFor('ignore'); declarePair(kernel);
    const pid = spawnClient(kernel, 'undeclared max'); kernel.step(); mustSucceed(request(kernel, pid, [A]));
    expect(() => kernel.setDeadlockStrategy('avoid')).toThrow(); expect(kernel.config.deadlockStrategy).toBe('ignore');
    mustSucceed(release(kernel, pid, [A])); kernel.setDeadlockStrategy('avoid');
    expect(request(kernel, pid, [A])).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(kernel.process(pid)).toMatchObject({ state: 'zombie', terminationReason: 'protection_fault', heldResources: [] });
  });

  it('uses corrected textbook citations throughout the deadlock modules', () => {
    const directory = fileURLToPath(new URL('../../../src/kernel/deadlock/', import.meta.url));
    for (const file of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
      expect(readFileSync(`${directory}/${file}`, 'utf8')).not.toMatch(/8\.6\.2|8\.3\.2/);
    }
  });
});

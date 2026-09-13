import type { JsonValue, KernelConfig, SchedulerContext, SubsystemEnvelope, Pid, SchedulerId, SchedulerParams, SchedulerPolicy } from '../types';
import { FcfsScheduler } from './FCFS';
import { SjfScheduler } from './sjf';
import { SrtfScheduler } from './srtf';
import { PriorityScheduler } from './priority';
import { SchedulerBase, snapshotArray, snapshotInteger, snapshotObject, snapshotPid, restoreSchedulerParams, saveSchedulerParams } from './SchedulerBase';
import { SchedulingAccounting } from './metrics';

export { tieBreak, EMPTY_METRICS, DEFAULT_SCHEDULER_PARAMS, isMetricsAware, isRunningAware } from './common';
export type { MetricsAwarePolicy, RunningAwarePolicy } from './common';
export { FcfsScheduler } from './FCFS';
export { SjfScheduler } from './sjf';
export { SrtfScheduler } from './srtf';
export { PriorityScheduler } from './priority';
export type SchedulerFactory = () => SchedulerPolicy;

// TODO(astra): WP-04 implements this policy
function priorityAging(): never { throw new Error('not implemented: priority_aging. Policy not implemented yet; see sim spec 5.6 (WP-04).'); }
// TODO(astra): WP-04 implements this policy
function roundRobin(): never { throw new Error('not implemented: rr. Policy not implemented yet; see sim spec 5.7 (WP-04).'); }
// TODO(astra): WP-04 implements this policy
function mlfq(): never { throw new Error('not implemented: mlfq. Policy not implemented yet; see sim spec 5.8 (WP-04).'); }

export const SCHEDULERS: Readonly<Record<SchedulerId, SchedulerFactory>> = {
  fcfs: () => new FcfsScheduler(), sjf: () => new SjfScheduler(),
  srtf: () => new SrtfScheduler(), priority: () => new PriorityScheduler(),
  priority_aging: priorityAging, rr: roundRobin, mlfq,
};
export function createScheduler(id: SchedulerId, params: SchedulerParams): SchedulerPolicy {
  const policy = SCHEDULERS[id](); policy.configure(params); return policy;
}

/** Supply raw workload bursts without adding fields to the frozen policy or PCB. */
export function configureSchedulerWorkload(policy: SchedulerPolicy, initialBurst: (pid: Pid) => number | undefined): void {
  if (policy instanceof SjfScheduler) policy.setInitialBurstSource(initialBurst);
}


export function saveSchedulerEnvelope(policy: SchedulerPolicy, accounting: SchedulingAccounting, runtime: JsonValue): SubsystemEnvelope {
  if (!(policy instanceof SchedulerBase)) throw new Error('scheduler persistence requires SchedulerBase');
  return { owner: 'scheduler', version: 1, payload: {
    policy: policy.saveState().payload, accounting: accounting.saveState(), runtime: structuredClone(runtime),
  } };
}

/** Prepare all three pieces before the kernel changes any execution state. */
export function prepareSchedulerRestore(envelope: SubsystemEnvelope, ctx: SchedulerContext,
  accounting: SchedulingAccounting, initialBurst: (pid: Pid) => number | undefined,
  config?: Pick<KernelConfig, 'scheduler' | 'schedulerParams'>) {
  if (envelope.owner !== 'scheduler' || envelope.version !== 1) throw new Error('invalid scheduler envelope owner or version');
  const payload = snapshotObject(envelope.payload, 'subsystem payload');
  const runtime = snapshotObject(payload['runtime'], 'runtime');
  const tick = snapshotInteger(runtime['tick'], 'tick');
  if (tick !== ctx.tick) throw new Error('scheduler snapshot tick mismatch');
  const readyQueue = snapshotArray(runtime['readyQueue'], 'ready order').map(pid => snapshotPid(pid, 'ready pid'));
  if (new Set(readyQueue).size !== readyQueue.length || readyQueue.length !== ctx.readyQueue.length
    || readyQueue.some(pid => !ctx.readyQueue.includes(pid))) throw new Error('scheduler runtime ready membership mismatch');
  const running = runtime['running'] === null ? null : snapshotPid(runtime['running'], 'runtime running');
  if (running !== ctx.running) throw new Error('scheduler runtime running mismatch');
  const lastCpuOwner = runtime['lastCpuOwner'] === null ? null : snapshotPid(runtime['lastCpuOwner'], 'previous CPU owner');
  if (lastCpuOwner !== null && ctx.process(lastCpuOwner) === undefined) throw new Error('unknown previous CPU owner');
  const sliceElapsed = snapshotInteger(runtime['sliceElapsed'], 'elapsed slice');
  const switchDebt = snapshotInteger(runtime['switchDebt'], 'switch debt');
  const contextSwitches = snapshotInteger(runtime['contextSwitches'], 'runtime context switches');
  const params = restoreSchedulerParams(runtime['params']);
  const policyPayload = snapshotObject(payload['policy'], 'policy');
  const id = restoreSchedulerId(policyPayload['policy']);
  if (config !== undefined && (config.scheduler !== id || !sameParams(params, config.schedulerParams))) {
    throw new Error('scheduler contribution disagrees with kernel config');
  }
  const policy = createScheduler(id, params);
  configureSchedulerWorkload(policy, initialBurst);
  if (!(policy instanceof SchedulerBase)) throw new Error('scheduler persistence requires SchedulerBase');
  const expectedParams = policy.configuredParams;
  policy.restoreState({ owner: 'scheduler', version: 1, payload: policyPayload }, ctx);
  if (!sameParams(expectedParams, policy.configuredParams)) throw new Error('scheduler policy and runtime params disagree');
  const accountingPayload = payload['accounting'];
  if (accountingPayload === undefined) throw new Error('missing scheduler accounting');
  const records = snapshotObject(accountingPayload, 'accounting');
  if (snapshotInteger(records['busyTicks'], 'busy ticks') > tick) throw new Error('scheduler busy ticks exceed elapsed time');
  for (const value of snapshotArray(records['firstRuns'], 'first runs')) {
    const pair = snapshotArray(value, 'first dispatch');
    if (ctx.process(snapshotPid(pair[0], 'first dispatch pid')) === undefined
      || snapshotInteger(pair[1], 'first dispatch tick') > tick) throw new Error('scheduler dispatch history mismatch');
  }
  for (const value of snapshotArray(records['completed'], 'completions')) {
    const row = snapshotObject(value, 'completion');
    const pcb = ctx.process(snapshotPid(row['pid'], 'completed pid'));
    if (pcb === undefined || (pcb.state !== 'zombie' && pcb.state !== 'terminated')
      || snapshotInteger(row['arrivalTick'], 'arrival') + snapshotInteger(row['turnaround'], 'turnaround') > tick) {
      throw new Error('scheduler completion history mismatch');
    }
  }
  const commitAccounting = accounting.prepareRestore(accountingPayload);
  return { policy, params, readyQueue, running, lastCpuOwner, sliceElapsed, switchDebt, contextSwitches, commitAccounting };
}

function restoreSchedulerId(value: JsonValue | undefined): SchedulerId {
  switch (value) {
    case 'fcfs': case 'sjf': case 'srtf': case 'priority': case 'priority_aging': case 'rr': case 'mlfq': return value;
    default: throw new Error('invalid saved scheduler id');
  }
}

function sameParams(a: Readonly<SchedulerParams>, b: Readonly<SchedulerParams>): boolean {
  // Parsing fixes property order and omits absent optional fields before comparison.
  return JSON.stringify(restoreSchedulerParams(saveSchedulerParams(a)))
    === JSON.stringify(restoreSchedulerParams(saveSchedulerParams(b)));
}

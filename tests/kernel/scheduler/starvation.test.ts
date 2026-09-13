import { describe, expect, it } from 'vitest';
import { KernelEventBus } from '@kernel/EventBus';
import { transition } from '@kernel/process/transitions';
import { FcfsScheduler } from '@kernel/scheduler/FCFS';
import {
  ageAndDetectStarvation, createSchedulerHooks, type StarvationEffects,
} from '@kernel/scheduler/starvation';
import { asPid, asTick } from '@kernel/types';
import type {
  KernelEvent, Pid, ProcessControlBlock, SchedulerContext, SchedulerParams,
  SchedulerPolicy, SchedulingDecision,
} from '@kernel/types';
import {
  createWorkloadKernel, schedulerParams, unitContext, unitProcesses,
} from './workloadRunner';

function fixture(count = 1, overrides: Partial<SchedulerParams> = {}) {
  const processes = unitProcesses(Array.from({ length: count }, (_, index) => ({
    name: `waiting-${index}`, arrival: 0, burst: 1000,
  })));
  const bus = new KernelEventBus();
  const events: KernelEvent[] = [];
  const terminated: Pid[] = [];
  const params = schedulerParams(overrides);
  const policy = new FcfsScheduler();
  policy.configure(params);
  let tick = asTick(0);
  bus.onAny(event => events.push(event));
  const effects: StarvationEffects = {
    emit: event => bus.emit(event),
    terminate: pcb => {
      terminated.push(pcb.pid);
      pcb.terminationReason = 'starvation';
      transition(pcb, 'zombie', { tick, emit: event => bus.emit(event) });
    },
  };
  const context = (at: number, readyQueue?: readonly Pid[]): SchedulerContext => {
    tick = asTick(at);
    bus.setTick(tick);
    return unitContext(processes, {
      tick, params,
      ...(readyQueue === undefined ? {} : { readyQueue }),
      emit: () => { throw new Error('starvation must use the stamping event emitter'); },
    });
  };
  const run = (at: number, readyQueue?: readonly Pid[]): void => {
    ageAndDetectStarvation(context(at, readyQueue), policy, effects);
  };
  return { processes, events, terminated, effects, context, run };
}

function processAt(processes: readonly ProcessControlBlock[], index: number): ProcessControlBlock {
  const pcb = processes[index];
  if (pcb === undefined) throw new Error(`missing fixture process ${index}`);
  return pcb;
}

describe('phase 6 starvation detection', () => {
  it('warning fires once during 400 ready ticks and is stamped by the event bus', () => {
    const f = fixture(1, { starvationFatalThreshold: 1000 });
    for (let tick = 0; tick <= 400; tick++) f.run(tick);
    expect(f.events).toEqual([{
      type: 'process.starving', pid: processAt(f.processes, 0).pid,
      tick: 120, seq: 0, waitedTicks: 120, fatal: false,
    }]);
    expect(f.terminated).toEqual([]);
    expect(processAt(f.processes, 0).state).toBe('ready');
  });

  it('uses strict warning equality and warns again only for a new ready residence', () => {
    const f = fixture(1, { starvationFatalThreshold: 1000 });
    const pcb = processAt(f.processes, 0);
    f.run(121);
    expect(f.events).toEqual([]);
    pcb.readySince = asTick(200);
    f.run(319);
    f.run(320);
    f.run(321);
    pcb.readySince = asTick(400);
    f.run(520);
    f.run(521);
    expect(f.events).toMatchObject([
      { type: 'process.starving', tick: 320, waitedTicks: 120, fatal: false },
      { type: 'process.starving', tick: 520, waitedTicks: 120, fatal: false },
    ]);
    expect(f.events).toHaveLength(2);
  });

  it('emits fatal at 300 before the T8 zombie transition and never repeats after exit', () => {
    const f = fixture();
    const pcb = processAt(f.processes, 0);
    f.run(299);
    expect(f.terminated).toEqual([]);
    f.run(300);
    f.run(301, [pcb.pid]);
    expect(f.events).toMatchObject([
      { type: 'process.starving', pid: pcb.pid, waitedTicks: 300, fatal: true },
      { type: 'process.state_changed', pid: pcb.pid, from: 'ready', to: 'zombie' },
    ]);
    expect(f.events).toHaveLength(2);
    expect(f.terminated).toEqual([pcb.pid]);
    expect(pcb).toMatchObject({ state: 'zombie', readySince: null, terminationReason: 'starvation' });
  });

  it('fatal is inclusive when the first scan occurs after 300', () => {
    const f = fixture();
    f.run(301);
    expect(f.events[0]).toMatchObject({ type: 'process.starving', waitedTicks: 301, fatal: true });
    expect(f.terminated).toEqual([processAt(f.processes, 0).pid]);
  });

  it('SABLE warns at 360 and dies at 900 without changing another process thresholds', () => {
    const f = fixture(2);
    const ordinary = processAt(f.processes, 0);
    const sable = processAt(f.processes, 1);
    sable.convoyMemberId = 'sable';
    for (let tick = 0; tick <= 900; tick++) f.run(tick);
    expect(f.events.filter(event => event.type === 'process.starving')).toMatchObject([
      { pid: ordinary.pid, tick: 120, waitedTicks: 120, fatal: false },
      { pid: ordinary.pid, tick: 300, waitedTicks: 300, fatal: true },
      { pid: sable.pid, tick: 360, waitedTicks: 360, fatal: false },
      { pid: sable.pid, tick: 900, waitedTicks: 900, fatal: true },
    ]);
    expect(f.terminated).toEqual([ordinary.pid, sable.pid]);
    expect(sable).toMatchObject({ state: 'zombie', terminationReason: 'starvation' });
  });

  it('crossings follow ascending pid order without changing ready insertion order', () => {
    const f = fixture(3);
    const ascending = f.processes.map(pcb => pcb.pid);
    const readyQueue = [...ascending].reverse();
    f.run(120, readyQueue);
    f.run(300, readyQueue);
    const starving = f.events.filter(event => event.type === 'process.starving');
    expect(starving.filter(event => !event.fatal).map(event => event.pid)).toEqual(ascending);
    expect(starving.filter(event => event.fatal).map(event => event.pid)).toEqual(ascending);
    expect(f.terminated).toEqual(ascending);
    expect(readyQueue).toEqual([...ascending].reverse());
  });

  it('skips waiting, running, missing and ready processes without readySince', () => {
    const f = fixture(3);
    const waiting = processAt(f.processes, 0);
    waiting.state = 'waiting';
    waiting.readySince = null;
    const running = processAt(f.processes, 1);
    running.state = 'running';
    running.readySince = asTick(0);
    processAt(f.processes, 2).readySince = null;
    const staleQueue = [...f.processes.map(pcb => pcb.pid), asPid(999)];
    f.run(120, staleQueue);
    f.run(300, staleQueue);
    expect(f.events).toEqual([]);
    expect(f.terminated).toEqual([]);
  });

  it('real kernel emits warning and fatal before lifecycle cleanup leaves a zombie', () => {
    const { kernel, pids } = createWorkloadKernel('fcfs', {}, [
      { name: 'holder', arrival: 0, burst: 1000 },
      { name: 'victim', arrival: 0, burst: 1000 },
    ]);
    const victim = pids.get('victim');
    if (victim === undefined) throw new Error('missing victim');
    const events: KernelEvent[] = [];
    const decisions: ProcessControlBlock['state'][] = [];
    kernel.events.onAny(event => events.push(event));
    kernel.step();
    const readySince = kernel.process(victim)?.readySince;
    if (readySince === undefined || readySince === null) throw new Error('victim was not held ready');
    const fatalTick = readySince + 300;
    kernel.onPhase((phase, tick) => {
      if (phase === 7 && tick === fatalTick) {
        const pcb = kernel.process(victim);
        if (pcb !== undefined) decisions.push(pcb.state);
      }
    });
    while (kernel.tick < fatalTick) kernel.step();
    expect(events.filter(event => event.type === 'process.starving')).toMatchObject([
      { pid: victim, tick: readySince + 120, waitedTicks: 120, fatal: false },
      { pid: victim, tick: fatalTick, waitedTicks: 300, fatal: true },
    ]);
    expect(kernel.process(victim)).toMatchObject({
      state: 'zombie', readySince: null, terminationReason: 'starvation', threads: [],
    });
    expect(decisions).toEqual(['zombie']);
    const fatalFrame = events.filter(event => event.tick === fatalTick);
    const fatalIndex = fatalFrame.findIndex(event => event.type === 'process.starving' && event.fatal);
    const stateIndex = fatalFrame.findIndex(event => event.type === 'process.state_changed'
      && event.pid === victim && event.to === 'zombie');
    const exitIndex = fatalFrame.findIndex(event => event.type === 'process.exited' && event.pid === victim);
    expect(fatalIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThan(fatalIndex);
    expect(exitIndex).toBeGreaterThan(stateIndex);
  });
});

describe('phase 6 aging extension', () => {
  it('calls the protected onAge bridge before detection and the scheduling decision', () => {
    const f = fixture();
    const pcb = processAt(f.processes, 0);
    const trace: string[] = [];
    class AgingProbe extends FcfsScheduler {
      protected override onAge(ctx: SchedulerContext): void {
        trace.push('age');
        const waiting = ctx.process(pcb.pid);
        if (waiting !== undefined) waiting.priority = 0;
      }
      override onTick(ctx: SchedulerContext): SchedulingDecision {
        trace.push(`decision:${ctx.process(pcb.pid)?.priority}`);
        return super.onTick(ctx);
      }
    }
    const policy = new AgingProbe();
    const ctx = f.context(120);
    policy.configure(schedulerParams());
    policy.onAdmit(pcb, ctx);
    const effects: StarvationEffects = {
      emit: event => { trace.push(`warning:${pcb.priority}`); f.effects.emit(event); },
      terminate: f.effects.terminate,
    };
    const hooks = createSchedulerHooks(() => policy, effects);
    hooks.ageAndDetectStarvation(ctx);
    expect(policy.onTick(ctx).next).toBe(pcb.pid);
    expect(trace).toEqual(['age', 'warning:0', 'decision:0']);
  });

  it('resolves the current policy after a mid-run swap and accepts a policy without aging', () => {
    const f = fixture();
    const aged: number[] = [];
    class AgingProbe extends FcfsScheduler {
      protected override onAge(ctx: SchedulerContext): void { aged.push(ctx.tick); }
    }
    const fcfs = new FcfsScheduler();
    let active: SchedulerPolicy = {
      id: fcfs.id, displayName: fcfs.displayName, isPreemptive: fcfs.isPreemptive,
      configure: params => fcfs.configure(params),
      onAdmit: (pcb, ctx) => fcfs.onAdmit(pcb, ctx),
      onTick: ctx => fcfs.onTick(ctx),
      onBlock: (pcb, ctx) => fcfs.onBlock(pcb, ctx),
      onUnblock: (pcb, ctx) => fcfs.onUnblock(pcb, ctx),
      onExit: (pcb, ctx) => fcfs.onExit(pcb, ctx),
      snapshot: () => fcfs.snapshot(),
    };
    const hooks = createSchedulerHooks(() => active, f.effects);
    hooks.ageAndDetectStarvation(f.context(1));
    active = new AgingProbe();
    hooks.ageAndDetectStarvation(f.context(2));
    active = fcfs;
    hooks.ageAndDetectStarvation(f.context(3));
    expect(aged).toEqual([2]);
    expect(f.events).toEqual([]);
  });
});

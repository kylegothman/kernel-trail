import type { KernelImpl } from '../../Kernel';
import { instructionProgram } from '../../process/Program';
import { asPageId, asResourceId } from '../../types';
import type { SyncSnapshotScenario } from '../../types';
import { RETIRE, RETRY, check, sameActor } from '../SyncSubsystem';
import type { Actor, AttemptResult, ScenarioContext } from '../SyncSubsystem';

export type BoundedBufferState = Extract<SyncSnapshotScenario, { kind: 'bounded_buffer' }>;
export interface BoundedBufferOptions {
  readonly id?: string;
  readonly variant?: BoundedBufferState['variant'];
  readonly capacity?: number;
  readonly producers?: number;
  readonly consumers?: number;
  readonly producerItems?: number;
  readonly consumerItems?: number;
  readonly producerTicks?: number;
  readonly consumerTicks?: number;
  readonly reordering?: boolean;
}

/** The five textbook lines are five separately scheduled instructions. */
export function executeBoundedBuffer(ctx: ScenarioContext, initial: BoundedBufferState, actor: Actor, step: number): AttemptResult {
  const row = initial.actors.find(value => sameActor(value.actor, actor));
  check(row !== undefined && step >= 0 && step <= 4, 'bounded-buffer actor or step');
  const producer = row.role === 'producer';
  const counting = producer ? initial.empty : initial.full;
  const reversed = producer && initial.variant === 'wrong_order';
  if (step <= 1) {
    const resource = (step === 0) !== reversed ? counting : initial.mutex;
    const result = ctx.call(actor, { op: 'sem_wait', resource });
    check(result.ok, 'bounded-buffer wait');
    return RETIRE;
  }
  if (step === 2) {
    if (ctx.register(actor, 'buffer.loaded') === 0) {
      ctx.setRegister(actor, 'buffer.value', ctx.load(actor, initial.cell, true));
      ctx.setRegister(actor, 'buffer.loaded', 1);
    }
    if (ctx.register(actor, 'buffer.workDone') === 0) {
      const work = ctx.work(actor, row.workTicks);
      if (!work.advance) return work;
      ctx.setRegister(actor, 'buffer.workDone', 1);
    }
    if (!ctx.store(actor, initial.cell, ctx.register(actor, 'buffer.value') + (producer ? 1 : -1), true)) return RETRY;
    const state = boundedBufferState(ctx, initial.id);
    const reservation = state.reservations.find(value => sameActor(value.actor, actor) && !value.itemApplied);
    check(reservation !== undefined, 'bounded-buffer successful wait has no reservation');
    check(producer ? state.items.length < state.capacity : state.items.length > 0, 'bounded-buffer occupancy');
    ctx.setScenario({ ...state,
      items: producer ? [...state.items, state.produced + 1] : state.items.slice(1),
      produced: state.produced + (producer ? 1 : 0), consumed: state.consumed + (producer ? 0 : 1),
      reservations: state.reservations.map(value => value.permitId === reservation.permitId ? { ...value, itemApplied: true } : value),
    });
    ctx.setRegister(actor, 'buffer.loaded', 0); ctx.setRegister(actor, 'buffer.workDone', 0);
    return RETIRE;
  }
  const resource = step === 3 ? initial.mutex : producer ? initial.full : initial.empty;
  check(ctx.call(actor, { op: 'sem_post', resource }).ok, 'bounded-buffer post');
  if (step === 3) return RETIRE;
  // Posting can grant a different actor immediately, so reread its new reservation.
  const state = boundedBufferState(ctx, initial.id);
  const reservation = state.reservations.find(value => sameActor(value.actor, actor) && value.itemApplied);
  check(reservation !== undefined, 'bounded-buffer complementary post has no reservation');
  const completed = row.completedItems + 1;
  ctx.setScenario({ ...state, inFlight: state.inFlight - 1,
    reservations: state.reservations.filter(value => value.permitId !== reservation.permitId),
    actors: state.actors.map(value => sameActor(value.actor, actor) ? { ...value, completedItems: completed } : value),
  });
  if (completed === row.targetItems) { ctx.complete(actor.pid); return RETIRE; }
  return { advance: false, deferService: false, target: 0 };
}

function boundedBufferState(ctx: ScenarioContext, id: string): BoundedBufferState {
  const state = ctx.scenario(id); check(state.kind === 'bounded_buffer', 'bounded-buffer kind'); return state;
}

export function createBoundedBuffer(kernel: KernelImpl, options: BoundedBufferOptions = {}): BoundedBufferState {
  const id = options.id ?? 'bounded_buffer'; const variant = options.variant ?? 'correct';
  const capacity = options.capacity ?? 4; const producers = options.producers ?? 3; const consumers = options.consumers ?? 2;
  const producerItems = options.producerItems ?? 20; const consumerItems = options.consumerItems ?? 30;
  const producerTicks = options.producerTicks ?? (variant === 'unbalanced' ? 1 : 3);
  const consumerTicks = options.consumerTicks ?? (variant === 'unbalanced' ? 5 : 2);
  for (const value of [capacity, producers, consumers, producerItems, consumerItems, producerTicks, consumerTicks]) {
    check(Number.isSafeInteger(value) && value > 0, 'bounded-buffer configuration');
  }
  const sync = kernel.syncSubsystem;
  const mutex = asResourceId(`${id}:mutex`); const empty = asResourceId(`${id}:empty`); const full = asResourceId(`${id}:full`);
  sync.createSemaphore(mutex, 1, 1); sync.createSemaphore(empty, capacity, capacity); sync.createSemaphore(full, capacity, 0);
  const program = instructionProgram(Array.from({ length: 5 }, (_, step) => ({ kind: 'sync' as const, operation: { op: 'scenario' as const, scenario: id, step } })));
  const actors: BoundedBufferState['actors'][number][] = [];
  for (let index = 0; index < producers + consumers; index++) {
    const role = index < producers ? 'producer' : 'consumer';
    const pid = kernel.spawn({ name: `${id}:${role}:${index}`, priority: 20, arrival: 0, burst: 1_000_000, service: 1_000_000, pages: 1 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; check(tid !== undefined, 'bounded-buffer TCB');
    const actor = { pid, tid }; sync.registerActor(actor, id); sync.setMemoryOrder(pid, options.reordering ?? false);
    actors.push({ actor, role, targetItems: role === 'producer' ? producerItems : consumerItems,
      workTicks: role === 'producer' ? producerTicks : consumerTicks, completedItems: 0 });
  }
  const first = actors[0]; check(first !== undefined, 'bounded-buffer initial actor');
  const pcb = kernel.process(first.actor.pid); check(pcb !== undefined, 'bounded-buffer backing space');
  const region = asResourceId(`${id}:value`); const cell = `region:${id}:count`;
  kernel.ipc.createSharedRegion({ id: region, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 });
  sync.addRegionCell(cell, region);
  const state: BoundedBufferState = { kind: 'bounded_buffer', id, variant, capacity, mutex, empty, full, cell,
    items: [], produced: 0, consumed: 0, inFlight: 0, reservations: [], actors };
  sync.addScenario(state); return state;
}

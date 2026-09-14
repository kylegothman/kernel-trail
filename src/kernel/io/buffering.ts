import { boundedFifoPush, boundedFifoShift } from '../sync/scenarios/boundedBuffer';
import type { DeviceId, IoSnapshotBuffer, Tick } from '../types';
import { check, validInteger } from './drivers/DeviceDriver';
import type { Mutable } from './drivers/DeviceDriver';

export interface BufferHost {
  contents(requestId: number): readonly number[];
  consumed(requestId: number, contents: readonly number[]): void;
}
export class DeviceBuffer {
  private data: Mutable<IoSnapshotBuffer>;
  constructor(readonly device: DeviceId, scheme: IoSnapshotBuffer['scheme'], private readonly host: BufferHost, producerTicks = 1, consumerTicks = 1) {
    this.data = { device, scheme: structuredClone(scheme), producerTicks, consumerTicks, ready: [], filling: null,
      draining: null, producerWaiters: [], consumerWaiters: [], occupancySamples: [], stalls: 0 };
    this.validate(this.data);
  }
  get capacity(): number { return this.data.scheme.kind === 'single' ? 1 : this.data.scheme.kind === 'double' ? 2 : this.data.scheme.capacity; }
  get occupancy(): number { return this.data.ready.length + Number(this.data.filling !== null) + Number(this.data.draining !== null); }
  get bufferOccupancy(): number {
    const samples = this.data.occupancySamples; return samples.length === 0 ? 0 : samples.reduce((sum, row) => sum + row.occupancy, 0) / samples.length;
  }
  get bufferStalls(): number { return this.data.stalls; }
  enqueue(requestId: number): void { check(validInteger(requestId, 1), 'buffer request'); this.data.producerWaiters.push(requestId); }
  step(tick: Tick): { produced: boolean; consumed: boolean } {
    check(this.data.occupancySamples.at(-1)?.tick !== tick, 'buffer tick repeated');
    if (this.data.draining === null && this.data.ready.length > 0) {
      const next = boundedFifoShift(this.data.ready); this.data.ready = [...next.items];
      this.data.draining = { ...next.item, remainingTicks: this.data.consumerTicks };
    }
    if (this.data.filling === null && this.data.producerWaiters.length > 0 && this.occupancy < this.capacity
      && (this.data.scheme.kind !== 'single' || this.data.draining === null)) {
      const id = this.data.producerWaiters.shift(); check(id !== undefined, 'buffer producer');
      this.data.filling = { requestId: id, contents: [...this.host.contents(id)], remainingTicks: this.data.producerTicks };
    }
    if (this.data.filling === null && this.data.producerWaiters.length > 0) this.data.stalls += 1;
    const result = { produced: false, consumed: false };
    if (this.data.filling !== null) {
      const current = this.data.filling; current.remainingTicks -= 1;
      if (current.remainingTicks === 0) {
        this.data.ready = [...boundedFifoPush(this.data.ready, this.capacity, { requestId: current.requestId, contents: current.contents })];
        this.data.filling = null; result.produced = true;
      }
    }
    if (this.data.draining !== null) {
      const current = this.data.draining; current.remainingTicks -= 1;
      if (current.remainingTicks === 0) {
        this.data.draining = null; result.consumed = true; this.host.consumed(current.requestId, [...current.contents]);
      }
    }
    this.data.occupancySamples.push({ tick, occupancy: this.occupancy });
    if (this.data.occupancySamples.length > 100) this.data.occupancySamples.shift();
    return result;
  }
  remove(requestIds: ReadonlySet<number>): void {
    this.data.producerWaiters = this.data.producerWaiters.filter(id => !requestIds.has(id));
    this.data.consumerWaiters = this.data.consumerWaiters.filter(id => !requestIds.has(id));
    this.data.ready = this.data.ready.filter(item => !requestIds.has(item.requestId));
    if (this.data.filling !== null && requestIds.has(this.data.filling.requestId)) this.data.filling = null;
    if (this.data.draining !== null && requestIds.has(this.data.draining.requestId)) this.data.draining = null;
  }
  snapshot(): IoSnapshotBuffer { return structuredClone(this.data); }
  restore(state: IoSnapshotBuffer): void { this.validate(state); this.data = structuredClone(state) as Mutable<IoSnapshotBuffer>; }
  validate(state: IoSnapshotBuffer): void {
    const capacity = state.scheme.kind === 'single' ? 1 : state.scheme.kind === 'double' ? 2 : state.scheme.capacity;
    check(['single', 'double', 'circular'].includes(state.scheme.kind) && validInteger(capacity, 1), 'buffer capacity');
    check(validInteger(state.producerTicks, 1) && validInteger(state.consumerTicks, 1) && validInteger(state.stalls), 'buffer durations');
    check(state.ready.length + Number(state.filling !== null) + Number(state.draining !== null) <= capacity, 'buffer occupancy');
    check(state.scheme.kind !== 'single' || state.filling === null || state.draining === null, 'single buffer overlap');
    check(state.occupancySamples.length <= 100 && state.occupancySamples.every((row, index) => validInteger(row.tick) && validInteger(row.occupancy)
      && row.occupancy <= capacity && (index === 0 || row.tick > (state.occupancySamples[index - 1]?.tick ?? -1))), 'buffer samples');
    for (const [row, duration] of [[state.filling, state.producerTicks], [state.draining, state.consumerTicks]] as const) if (row !== null) check(validInteger(row.remainingTicks, 1) && row.remainingTicks <= duration, 'buffer continuation');
    const items = [...state.ready, ...(state.filling === null ? [] : [state.filling]), ...(state.draining === null ? [] : [state.draining])];
    const ids = [...state.producerWaiters, ...state.consumerWaiters, ...items.map(row => row.requestId)];
    check(ids.every(id => validInteger(id, 1)) && new Set(ids).size === ids.length, 'buffer request IDs');
    check(items.every(row => row.contents.every(byte => validInteger(byte) && byte <= 255)), 'buffer contents');
  }
}

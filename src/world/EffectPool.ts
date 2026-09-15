import { Vector3 } from 'three/webgpu';
import type { EffectSpawn, LiveEffect, OverflowPolicy } from './effects/types';

export interface EffectPoolOptions { readonly capacity: number; readonly overflow: OverflowPolicy; }
type MutableEffect = { -readonly [K in keyof LiveEffect]: LiveEffect[K] } & { readonly toStore: Vector3 };

/** Fixed storage for transient effects. Records and vectors are built once. */
export class EffectPool {
  private readonly items: MutableEffect[];
  private readonly free: Int32Array;
  private freeCount: number;
  private readonly order: Int32Array;
  private readonly activeView: LiveEffect[];
  private orderHead = 0;
  private orderCount = 0;
  private nextId = 1;
  private liveCount = 0;
  public evictions = 0;

  constructor(private readonly opts: EffectPoolOptions) {
    if (!Number.isInteger(opts.capacity) || opts.capacity < 1) throw new Error('EffectPool capacity must be positive');
    this.items = new Array<MutableEffect>(opts.capacity);
    this.free = new Int32Array(opts.capacity);
    this.order = new Int32Array(opts.capacity);
    this.activeView = new Array<LiveEffect>(opts.capacity);
    for (let i = 0; i < opts.capacity; i += 1) {
      const at = new Vector3();
      const toStore = new Vector3();
      this.items[i] = { kind: 'derezz', at, toStore, lifetimeSeconds: 0, intensity: 0, colour: 0, age: 0, slot: i, id: 0, alive: false };
      this.free[i] = i;
    }
    this.freeCount = opts.capacity;
  }

  get capacity(): number { return this.opts.capacity; }
  get inUse(): number { return this.liveCount; }
  get activeCount(): number { return this.liveCount; }
  get active(): readonly LiveEffect[] {
    let count = 0;
    for (let i = 0; i < this.orderCount; i += 1) {
      const effect = this.items[this.order[(this.orderHead + i) % this.opts.capacity]!]!;
      if (effect.alive) this.activeView[count++] = effect;
    }
    this.activeView.length = count;
    return this.activeView;
  }
  get instances(): readonly LiveEffect[] { return this.items; }

  spawn(spec: EffectSpawn): LiveEffect | null {
    let slot = this.freeCount > 0 ? this.free[--this.freeCount]! : -1;
    if (slot < 0) {
      if (this.opts.overflow === 'drop') return null;
      if (this.opts.overflow === 'aggregate') {
        const newestIndex = this.orderIndex(this.orderCount - 1);
        if (newestIndex >= 0) {
          const newest = this.items[newestIndex]!;
          newest.intensity = Math.min(1, newest.intensity + spec.intensity * 0.25);
        }
        return null;
      }
      slot = this.order[this.orderHead]!;
      this.orderHead = (this.orderHead + 1) % this.opts.capacity;
      this.items[slot]!.alive = false;
      this.liveCount -= 1;
      this.evictions += 1;
      this.orderCount -= 1;
    }

    const effect = this.items[slot]!;
    effect.kind = spec.kind;
    effect.at.copy(spec.at);
    if (spec.to) { effect.toStore.copy(spec.to); effect.to = effect.toStore; }
    else delete effect.to;
    if (spec.follow === undefined) delete effect.follow;
    else effect.follow = spec.follow;
    effect.lifetimeSeconds = Math.max(0, spec.lifetimeSeconds);
    effect.intensity = Math.max(0, Math.min(1, spec.intensity));
    effect.colour = spec.colour;
    if (spec.a === undefined) delete effect.a; else effect.a = spec.a;
    if (spec.b === undefined) delete effect.b; else effect.b = spec.b;
    if (spec.c === undefined) delete effect.c; else effect.c = spec.c;
    if (spec.d === undefined) delete effect.d; else effect.d = spec.d;
    effect.age = 0;
    effect.id = this.nextId++;
    effect.alive = true;
    const tail = (this.orderHead + this.orderCount) % this.opts.capacity;
    this.order[tail] = slot;
    this.orderCount += 1;
    this.liveCount += 1;
    return effect;
  }

  update(dtSeconds: number, onExpire?: (effect: LiveEffect) => void): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new Error('Invalid effect delta');
    for (let i = this.orderCount - 1; i >= 0; i -= 1) {
      const orderIndex = (this.orderHead + i) % this.opts.capacity;
      const slot = this.order[orderIndex]!;
      const effect = this.items[slot]!;
      effect.age += dtSeconds;
      if (effect.age < effect.lifetimeSeconds) continue;
      effect.alive = false;
      this.liveCount -= 1;
      this.free[this.freeCount++] = slot;
      this.removeOrderAt(i);
      onExpire?.(effect);
    }
  }

  forEachLive(fn: (effect: LiveEffect) => void): void {
    for (let i = 0; i < this.orderCount; i += 1) {
      const effect = this.items[this.order[(this.orderHead + i) % this.opts.capacity]!]!;
      if (effect.alive) fn(effect);
    }
  }

  clear(): void {
    for (let i = 0; i < this.orderCount; i += 1) {
      const effect = this.items[this.order[(this.orderHead + i) % this.opts.capacity]!]!;
      effect.alive = false;
      this.free[this.freeCount++] = effect.slot;
    }
    this.orderHead = 0;
    this.orderCount = 0;
    this.liveCount = 0;
    this.freeCount = 0;
    for (let i = 0; i < this.items.length; i += 1) this.free[this.freeCount++] = i;
    this.evictions = 0;
  }

  private orderIndex(offset: number): number {
    if (offset < 0 || offset >= this.orderCount) return -1;
    return this.order[(this.orderHead + offset) % this.opts.capacity]!;
  }

  private removeOrderAt(offset: number): void {
    for (let i = offset; i < this.orderCount - 1; i += 1) {
      this.order[(this.orderHead + i) % this.opts.capacity] = this.order[(this.orderHead + i + 1) % this.opts.capacity]!;
    }
    this.orderCount -= 1;
  }
}

import type { StorageVisuals as StorageContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class StorageVisuals extends DomainVisuals implements StorageContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onQueued(e: KernelEventOf<'disk.queued'>, _c: WorldEventContext): void { this.state(`disk:${e.request.id}:queued`, e.request.cylinder); }
  onSeek(e: KernelEventOf<'disk.seek'>, _c: WorldEventContext): void { this.spawn('seek_arc', this.amber(), Math.max(0.04, e.distance / 100), 1, e.from, e.to, e.distance); }
  onServed(e: KernelEventOf<'disk.served'>, _c: WorldEventContext): void { this.spawn('page_flare', this.cyan(), 0.16, 1, e.waitTicks); }
  onRaidRebuild(e: KernelEventOf<'raid.rebuild'>, _c: WorldEventContext): void { this.state(`raid:${e.failedDisk}:progress`, e.progress); }
}

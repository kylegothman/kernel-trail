import type { SyncVisuals as SyncContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class SyncVisuals extends DomainVisuals implements SyncContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onAcquired(e: KernelEventOf<'sync.acquired'>, _c: WorldEventContext): void { this.spawn('lock_pulse', this.cyan(), 0.12, 1, e.pid as number); }
  onBlocked(e: KernelEventOf<'sync.blocked'>, _c: WorldEventContext): void { this.spawn('denial_ward', this.amber(), 0.26, 1, e.queueLength); }
  onReleased(e: KernelEventOf<'sync.released'>, _c: WorldEventContext): void { this.spawn('lock_pulse', this.cyan(), 0.1, 1, e.woke as number | null ?? -1); }
  onRace(e: KernelEventOf<'sync.race_detected'>, _c: WorldEventContext): void {
    this.spawn('race_shear', this.amber(), 0.45, 0.45, e.race.corruptedValue, e.race.expectedValue, e.race.interleaving.length);
    this.spawn('race_shear', this.amber(), 0.45, 0.45, e.race.expectedValue, e.race.corruptedValue, e.race.interleaving.length);
    for (const step of e.race.interleaving) this.label(step);
    this.state('race:corrupted', e.race.corruptedValue);
    this.state('race:expected', e.race.expectedValue);
  }
  onBusyWait(e: KernelEventOf<'sync.busy_wait'>, _c: WorldEventContext): void { this.spawn('lock_pulse', this.amber(), 0.26, 1, e.spunTicks); }
}

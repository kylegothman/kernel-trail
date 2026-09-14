import { asTick } from '../types';
import type { Pid, SchedulerContext, SchedulerParams, Tick } from '../types';
import { PriorityScheduler } from './priority';
import { restoreSchedulerParams, snapshotInteger, snapshotObject, type SchedulerPolicyDetails } from './SchedulerBase';
import { applyAging } from './aging';

export class PriorityAgingScheduler extends PriorityScheduler {
  override readonly id = 'priority_aging';
  override readonly displayName = 'Priority Scheduling with Aging';
  private lastAgingTick: Tick | null = null;
  override configure(params: SchedulerParams): void {
    const checked = restoreSchedulerParams(params);
    super.configure(checked); this.params = { ...this.params, agingInterval: checked.agingInterval };
  }
  protected override onAge(ctx: SchedulerContext): void {
    if (this.lastAgingTick === ctx.tick) return;
    this.lastAgingTick = ctx.tick;
    applyAging({ ...ctx, params: this.params }, ctx.readyQueue); this.markPrioritiesDirty();
  }
  protected override saveDetails(): SchedulerPolicyDetails {
    return { policy: 'priority_aging', detail: { lastAgingTick: this.lastAgingTick } };
  }
  protected override prepareRestoreDetails(detail: unknown, queues: readonly (readonly Pid[])[], ctx: SchedulerContext): () => void {
    const value = snapshotObject(detail, 'priority aging detail');
    const lastAgingTick = value['lastAgingTick'] === null ? null : asTick(snapshotInteger(value['lastAgingTick'], 'last aging tick'));
    if (lastAgingTick !== null && lastAgingTick > ctx.tick) throw new Error('scheduler aging clock is in the future');
    const commit = super.prepareRestoreDetails(null, queues, ctx);
    return () => { commit(); this.lastAgingTick = lastAgingTick; };
  }
}

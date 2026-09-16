import type { Rations } from '../types';
import { quotaPerTick } from '../travel/paceRations';

export type CrossingOption = 'spin' | 'block' | 'monitor' | 'wait';

export interface CrossingContext {
  readonly contention: number;
  readonly ordered: boolean;
  readonly rations: Rations;
  readonly aliveCount: number;
  readonly crosserHoldsResource: boolean;
}

export interface CrossingQuote {
  readonly option: CrossingOption;
  readonly cyclesCost: number;
  readonly ticksCost: number;
  readonly quotaCost: number;
  readonly bandwidthCost: number;
  readonly blocksCost: number;
  readonly successP: number;
  readonly eventDraws: number;
}

/** Narrative 12.2. Quoting never consumes a random draw. */
export function quote(option: CrossingOption, ctx: CrossingContext): CrossingQuote {
  const c = Math.min(1, Math.max(0, ctx.contention));
  const base = { option, cyclesCost: 0, quotaCost: 0, bandwidthCost: 0, blocksCost: 0, eventDraws: 0 };
  switch (option) {
    case 'spin': return { ...base, cyclesCost: Math.round(12 + 90 * c), ticksCost: Math.round(4 + 30 * c), successP: 1 - 0.85 * c ** 2 };
    case 'block': {
      const ticksCost = Math.round(20 + 60 * c);
      return { ...base, ticksCost, quotaCost: ticksCost * quotaPerTick(ctx.rations, ctx.aliveCount), successP: ctx.ordered ? 0.99 : 1 - 0.55 * c ** 2 };
    }
    case 'monitor': return { ...base, cyclesCost: Math.round(45 + 120 * c), bandwidthCost: 6, ticksCost: 8, successP: 0.97 };
    case 'wait': {
      const ticksCost = Math.round(40 + 120 * c);
      const after = c * 0.86 ** (ticksCost / 10);
      return { ...base, ticksCost, quotaCost: ticksCost * quotaPerTick(ctx.rations, ctx.aliveCount), eventDraws: Math.floor(ticksCost / 10), successP: 1 - 0.20 * after ** 2 };
    }
  }
}

export function quoteAll(ctx: CrossingContext): Readonly<Record<CrossingOption, CrossingQuote>> {
  return { spin: quote('spin', ctx), block: quote('block', ctx), monitor: quote('monitor', ctx), wait: quote('wait', ctx) };
}

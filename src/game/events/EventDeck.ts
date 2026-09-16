import type { ConvoyMemberId, Rng, Tick } from '@kernel/index';
import type { AfflictionId, DifficultyTier, LegId, RandomEventDef, ResourceLedger, RunState } from '../types';
import { acquire } from '../afflictions/AfflictionClock';
import { TIER_TABLE } from '../tiers';
import { applyDelta } from '../travel/ledger';

export type EventPredicate = (def: RandomEventDef, run: RunState) => boolean;
export interface DrawContext {
  readonly run: RunState;
  readonly rng: Rng;
  readonly at: Tick;
  readonly legId: LegId;
  readonly predicate?: EventPredicate;
}
export interface EventApplication {
  readonly def: RandomEventDef;
  readonly target: ConvoyMemberId | null;
  readonly inflicted: AfflictionId | null;
  readonly delta: Partial<ResourceLedger>;
}

export function eligible(table: readonly RandomEventDef[], run: RunState, predicate?: EventPredicate): readonly RandomEventDef[] {
  return table.filter(def => {
    if (predicate !== undefined) return predicate(def, run);
    try { return def.onlyIf === null || def.onlyIf(run); } catch { return false; }
  });
}

export function draw(table: readonly RandomEventDef[], ctx: DrawContext): RandomEventDef | null {
  const entries = eligible(table, ctx.run, ctx.predicate);
  const total = entries.reduce((sum, def) => sum + def.weight, 0);
  if (total <= 0) return null;
  const roll = ctx.rng.int(1, total + 1);
  let weight = 0;
  for (const def of entries) {
    weight += def.weight;
    if (roll <= weight) return def;
  }
  return null;
}

/** Called only with a store mutation's draft; the deck never retains the run. */
export function apply(def: RandomEventDef, ctx: DrawContext): EventApplication {
  const targets = ctx.run.convoy.filter(m => m.status !== 'derezzed' &&
    (def.targets === null || m.role === def.targets)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const target = targets.length === 0 ? undefined : targets[ctx.rng.int(0, targets.length)];
  let inflicted: AfflictionId | null = null;
  if (target !== undefined && def.inflicts !== null && afflictionRoll(ctx.run.difficulty, ctx.rng)) {
    if (acquire(target, def.inflicts, ctx.at)) inflicted = def.inflicts;
  }
  applyDelta(ctx.run.resources, def.resourceDelta);
  return { def, target: target?.id ?? null, inflicted, delta: { ...def.resourceDelta } };
}

function afflictionRoll(tier: DifficultyTier, rng: Rng): boolean {
  const frequency = TIER_TABLE[tier].afflictionFrequency;
  return frequency >= 1 || rng.chance(frequency);
}

export function validateTable(table: readonly RandomEventDef[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const def of table) {
    if (!Number.isSafeInteger(def.weight) || def.weight <= 0) problems.push(`${def.id}: weight must be a positive integer`);
    total += def.weight;
    if (seen.has(def.id)) problems.push(`${def.id}: duplicate id`);
    seen.add(def.id);
    if (def.narration.trim().length === 0) problems.push(`${def.id}: empty narration`);
  }
  if (total !== 100) problems.push(`weights total ${total}, expected 100`);
  return problems;
}

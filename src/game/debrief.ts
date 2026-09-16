import type { CodexCounterfactual } from './codexTypes';
import type { DebriefCard, Epitaph, LegOutcome, ResourceLedger, RunState } from './types';
import { applyDelta } from './travel/ledger';

export interface DebriefInput {
  readonly outcome: LegOutcome;
  readonly run: RunState;
  readonly legTicks: number;
  readonly throughputFactor: number;
  readonly dividend: number;
  readonly counterfactual?: Promise<string | null>;
  readonly codexCounterfactual?: Promise<CodexCounterfactual | null>;
}
export interface DebriefView {
  readonly card: DebriefCard;
  readonly dividend: number;
  readonly ledgerBefore: ResourceLedger;
  readonly ledgerAfter: ResourceLedger;
  readonly casualties: readonly Epitaph[];
  readonly objectivesMet: readonly string[];
  readonly codexUnlocked: readonly string[];
  readonly counterfactual: Promise<string | null>;
  readonly codexCounterfactual: Promise<CodexCounterfactual | null>;
}

export function buildDebrief(input: DebriefInput): DebriefView {
  const before = { ...input.run.resources };
  const after = { ...before };
  applyDelta(after, input.outcome.resourceDelta);
  applyDelta(after, { cycles: input.dividend });
  return {
    card: input.outcome.debrief,
    dividend: input.dividend,
    ledgerBefore: before,
    ledgerAfter: after,
    casualties: input.run.tombstones.filter(e => input.outcome.casualties.includes(e.member)),
    objectivesMet: [...input.outcome.objectivesMet],
    codexUnlocked: [...input.outcome.codexUnlocked],
    counterfactual: input.counterfactual ?? Promise.resolve(null),
    codexCounterfactual: input.codexCounterfactual ?? Promise.resolve(null),
  };
}

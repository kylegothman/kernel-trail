/**
 * The Boot Sector's judgement. Nothing dies here by design: permadeath with no
 * information is punishment rather than teaching, so `survived` is a constant
 * and `casualties` is empty for every input. The failure is deferred and
 * real, and the debrief states the closing ledger against the floors without
 * saying how to fix it.
 *
 * `resourceDelta` is empty (pre-flight ruling 7): the director applied every
 * interaction cost and event delta to the ledger live, so a second summing
 * here would move the ledger twice.
 */
import type { ConvoyMemberId } from '@kernel/types';
import { LEG_SEGMENTS } from '@game/travel/segments';
import { PACE_TABLE } from '@game/travel/paceRations';
import type { DebriefCard, LegEvaluationContext, LegOutcome, ResourceLedger } from '@game/types';
import { asKernelEvents } from '../events';
import { CODEX_IDS } from './copy';
import { OBJECTIVE_IDS } from './objectives';
import { acquiredServices, correctLabels, firstSuccessIndex, reduceRequisition, TRAP_COST, WINDOW_IDS, type RequisitionState } from './windows';

/** The recommended closing floors, curriculum map leg 0, `obj.boot_sector.mode_switch_budget`. */
export const FLOORS: Readonly<ResourceLedger> = { cycles: 120, quota: 24, blocks: 30, bandwidth: 40 };
/** Overhead under this many cycles meets the budget objective. */
export const OVERHEAD_LIMIT = 40;
/** Two submissions cover the whole requisition; the counterfactual prices the difference against them. */
export const BATCHED_OVERHEAD = 2 * TRAP_COST;
/** Six single-item submissions; overhead above this earns counterfactual case 1 (package, "Debrief card"). */
export const CASE_ONE_THRESHOLD = 6 * TRAP_COST;
/** The labels a player may miss and still meet the classification objective. */
export const LABELS_REQUIRED = 5;
/** Distinct `man` topics read before the first successful purchase. */
export const MANUALS_REQUIRED = 2;

/** No death path, as a constant nobody later "fixes": the Boot Sector is outfitting, not a trial. */
export const SURVIVED = true as const;
export const CASUALTIES: readonly ConvoyMemberId[] = [];

/** The Quantum Pass at steady pace: narrative 5.3 segments times the pace's effective cycles per segment. */
export function quantumPassSteadyCost(): number {
  return LEG_SEGMENTS.quantum_pass * PACE_TABLE.steady.effectiveCyclesPerSegment;
}

export interface Judgement {
  readonly state: RequisitionState;
  readonly trapCount: number;
  readonly overhead: number;
  readonly kernelEperm: number;
  readonly objectivesMet: readonly string[];
}

export function judge(ctx: LegEvaluationContext): Judgement {
  const events = asKernelEvents(ctx.events);
  const state = reduceRequisition(ctx.run.decisions, ctx.run.discClass, ctx.run.difficulty);
  const trapCount = state.submissions.length;
  const overhead = trapCount * TRAP_COST;
  const kernelEperm = events.filter((event) => event.type === 'syscall.invoked' && !event.result.ok && event.result.errno === 'EPERM').length;
  const ledger = ctx.run.resources;
  const met: string[] = [];
  const acquired = acquiredServices(state);
  const refused = state.submissions.filter((submission) => submission.errno === 'EPERM').length;
  if (WINDOW_IDS.every((id) => acquired.has(id)) && refused === 0 && kernelEperm === 0) met.push(OBJECTIVE_IDS.acquireViaTrap);
  const floorsMet = (['cycles', 'quota', 'blocks', 'bandwidth'] as const).every((key) => ledger[key] >= FLOORS[key]);
  if (overhead < OVERHEAD_LIMIT && floorsMet) met.push(OBJECTIVE_IDS.modeSwitchBudget);
  if (correctLabels(state) >= LABELS_REQUIRED) met.push(OBJECTIVE_IDS.classifyPrivilege);
  if (Math.min(ledger.cycles, ledger.quota, ledger.blocks, ledger.bandwidth) > 0) met.push(OBJECTIVE_IDS.balancedLedger);
  const firstSuccess = firstSuccessIndex(state);
  const topics = new Set(state.manInvocations.filter((call) => firstSuccess === null || call.decisionIndex < firstSuccess).map((call) => call.topic));
  if (topics.size >= MANUALS_REQUIRED) met.push(OBJECTIVE_IDS.consultManual);
  if (state.gate !== null && state.gate.correct) met.push(OBJECTIVE_IDS.discClassTradeoff);
  return { state, trapCount, overhead, kernelEperm, objectivesMet: met };
}

/**
 * Computed, never authored. Case 1 when overhead exceeds 24 cycles, case 2
 * when quota is under its floor, null when every floor is cleared.
 * When both apply the larger shortfall wins and a tie goes to case 1
 * (pre-flight ruling 5).
 */
export function counterfactual(overhead: number, quota: number): string | null {
  const overheadShortfall = overhead - CASE_ONE_THRESHOLD;
  const quotaShortfall = FLOORS.quota - quota;
  const caseOne = overheadShortfall > 0;
  const caseTwo = quotaShortfall > 0;
  if (caseOne && (!caseTwo || overheadShortfall >= quotaShortfall)) {
    return `The same purchases in two submissions would have cost ${BATCHED_OVERHEAD} cycles of overhead instead of ${overhead}. That difference is ${overhead - BATCHED_OVERHEAD} cycles, and the Quantum Pass costs ${Math.round(quantumPassSteadyCost())} at steady pace.`;
  }
  if (caseTwo) {
    return `You are carrying ${Math.round(quota)} quota. The Fork Fields needs enough to hold five address spaces plus the scouts you will create there.`;
  }
  return null;
}

export function debriefCard(judgement: Judgement, ledger: Readonly<ResourceLedger>): DebriefCard {
  const { trapCount, overhead } = judgement;
  return {
    headline: 'Outfitted.',
    whatHappened:
      `You raised ${trapCount} traps and paid ${overhead} cycles for the crossings alone. ` +
      `You left the Boot Sector with ${Math.round(ledger.cycles)} cycles, ${Math.round(ledger.quota)} quota, ${Math.round(ledger.blocks)} blocks and ${Math.round(ledger.bandwidth)} bandwidth.`,
    whyItHappened:
      'Every resource on this plate was on the other side of a trap. A trap costs the same ' +
      'whether it carries one item or a hundred, because what you are paying for is the mode ' +
      'switch and the argument validation, not the goods.',
    counterfactual: counterfactual(overhead, ledger.quota),
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1'] },
  };
}

export function evaluate(ctx: LegEvaluationContext): LegOutcome {
  const judgement = judge(ctx);
  return {
    survived: SURVIVED,
    objectivesMet: judgement.objectivesMet,
    casualties: CASUALTIES,
    resourceDelta: {},
    codexUnlocked: CODEX_IDS,
    debrief: debriefCard(judgement, ctx.run.resources),
  };
}

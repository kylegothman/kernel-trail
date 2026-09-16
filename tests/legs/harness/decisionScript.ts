/**
 * WP-20 section 3: the scripted decision sequence. A script describes what
 * the player did and contains no assertion; what the run should produce is
 * `expectOutcome`'s job. Scope correction W7 adds the crossing list a script
 * registers at entry, and the pre-flight adds the interaction registrations
 * a script's `interaction` commands need (a leg's `InteractionDef` is only
 * dispatchable once a handler is registered by id, which is content the boot
 * package supplies; the harness registers a no-op handler and the target).
 */
import type { ConvoyMemberId } from '@kernel/types';
import { describeChoice, type Command } from '@game/CommandBus';
import type { CrossingDef } from '@game/crossing/Crossing';
import type { CrossingOption } from '@game/crossing/options';
import type { DepotItemId } from '@game/depot/Depot';
import type { ReclamationTrace } from '@game/reclamation/Reclamation';
import { DEPOT_LEGS } from '@game/travel/segments';
import type { AfflictionId, LegId, ResourceKind } from '@game/types';

/** One scripted player action, scheduled by tick or by a condition. */
export type ScriptStep =
  | { readonly at: number; readonly command: Command }
  | { readonly when: ScriptTrigger; readonly command: Command }
  | { readonly at: number; readonly crossing: string; readonly option: CrossingOption }
  | { readonly at: number; readonly depot: DepotItemId; readonly target: ConvoyMemberId | null }
  | { readonly at: number; readonly reclamation: ReclamationTrace };

/** Conditions the script can wait on, all read from live state. */
export type ScriptTrigger =
  | { readonly kind: 'event'; readonly type: string }
  | { readonly kind: 'event'; readonly type: string; readonly nth: number }
  | { readonly kind: 'integrity_below'; readonly member: ConvoyMemberId; readonly value: number }
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'progress_at_least'; readonly value: number }
  | { readonly kind: 'resource_below'; readonly resource: ResourceKind; readonly value: number };

export interface ScriptInteraction {
  readonly id: string;
  readonly target: ConvoyMemberId | null;
}

export interface DecisionScript {
  readonly legId: LegId;
  readonly label: string;
  readonly steps: readonly ScriptStep[];
  /** Crossing defs the harness registers on the runner at entry (W7). */
  readonly crossings?: readonly CrossingDef[];
  /** Interactions the harness registers by id with a no-op handler so the leg's cost and predicate apply. */
  readonly interactions?: readonly ScriptInteraction[];
}

export function isWhenStep(step: ScriptStep): step is Extract<ScriptStep, { when: ScriptTrigger }> {
  return 'when' in step;
}

/** The tick an `at` step fires before, or null for a `when` step. */
export function stepTick(step: ScriptStep): number | null {
  return isWhenStep(step) ? null : step.at;
}

export function describeStep(step: ScriptStep): string {
  if ('command' in step) {
    const when = isWhenStep(step) ? `when ${describeTrigger(step.when)}` : `at ${step.at}`;
    return `${when}: ${step.command.kind} ${describeChoice(step.command)}`;
  }
  if ('crossing' in step) return `at ${step.at}: crossing ${step.crossing} ${step.option}`;
  if ('depot' in step) return `at ${step.at}: depot ${step.depot}${step.target === null ? '' : ` for ${step.target}`}`;
  return `at ${step.at}: reclamation with ${step.reclamation.length} action(s)`;
}

export function describeTrigger(trigger: ScriptTrigger): string {
  switch (trigger.kind) {
    case 'event':
      return `event ${trigger.type}${'nth' in trigger ? ` #${trigger.nth}` : ''}`;
    case 'integrity_below':
      return `integrity of ${trigger.member} below ${trigger.value}`;
    case 'affliction':
      return `affliction ${trigger.id}`;
    case 'progress_at_least':
      return `progress at least ${trigger.value}`;
    case 'resource_below':
      return `${trigger.resource} below ${trigger.value}`;
  }
}

const POLICY_KINDS: ReadonlySet<Command['kind']> = new Set([
  'set_scheduler', 'set_replacement', 'set_disk_policy', 'set_allocation', 'set_deadlock_strategy', 'set_pace', 'set_rations', 'set_degree',
]);

/**
 * Problems, never a throw: a negative or fractional tick, two steps at the
 * same tick setting the same dial to different values, a crossing id the
 * script's own list does not declare, a depot purchase on a leg with no
 * depot, and a `when` step whose `nth` is not a positive integer.
 */
export function validateScript(script: DecisionScript): readonly string[] {
  const problems: string[] = [];
  const declared = new Set((script.crossings ?? []).map((def) => def.id));
  const dials = new Map<string, string>();
  script.steps.forEach((step, index) => {
    const label = `step ${index} (${describeStep(step)})`;
    const at = stepTick(step);
    if (at !== null && (!Number.isInteger(at) || at < 0)) problems.push(`${label}: tick ${String(at)} is not a non-negative integer`);
    if (isWhenStep(step) && step.when.kind === 'event' && 'nth' in step.when && (!Number.isInteger(step.when.nth) || step.when.nth < 1)) {
      problems.push(`${label}: nth must be a positive integer`);
    }
    if ('command' in step && at !== null && POLICY_KINDS.has(step.command.kind)) {
      const key = `${at}:${step.command.kind}`;
      const choice = describeChoice(step.command);
      const earlier = dials.get(key);
      if (earlier !== undefined && earlier !== choice) problems.push(`${label}: contradicts an earlier ${step.command.kind} at tick ${at} (${earlier} versus ${choice})`);
      else dials.set(key, choice);
    }
    if ('crossing' in step && !declared.has(step.crossing)) problems.push(`${label}: crossing ${step.crossing} is not declared in the script's crossings list`);
    if ('depot' in step && !DEPOT_LEGS.includes(script.legId)) problems.push(`${label}: ${script.legId} has no depot`);
  });
  for (const def of script.crossings ?? []) {
    if (def.legId !== script.legId) problems.push(`crossing ${def.id} belongs to ${def.legId}, not ${script.legId}`);
  }
  return problems;
}

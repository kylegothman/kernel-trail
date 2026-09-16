/**
 * WP-20 section 2: a real `RunState`, never a partial one. Built on the
 * game's own `initialRunState` (the shared roster, `startingLedger` and the
 * default degree, WP-19 ruling R4) so a fixture's entering state differs from
 * a live run's only where the fixture says so.
 */
import { DEFAULT_DEGREE, initialRunState } from '@game/replay/runReplay';
import type { ConvoyMember, DecisionRecord, DifficultyTier, DiscClass, Pace, Rations, ResourceLedger, RunState } from '@game/types';

export interface RunStateOptions {
  readonly seed: number;
  readonly legIndex: number;
  readonly discClass?: DiscClass;
  readonly difficulty?: DifficultyTier;
  readonly pace?: Pace;
  readonly rations?: Rations;
  /** The degree of multiprogramming; the run's default (6) when omitted, since `KernelConfig` carries none. */
  readonly degree?: number;
  /** The closing ledger of the previous leg's golden run. */
  readonly ledger?: Partial<ResourceLedger>;
  /** Records a previous leg wrote that this leg reads. See section 8. */
  readonly decisions?: readonly DecisionRecord[];
  readonly convoy?: readonly Partial<ConvoyMember>[];
}

const LEDGER_KEYS = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;

export function makeRunState(opts: RunStateOptions): RunState {
  const run = initialRunState(opts.seed, opts.discClass ?? 'shell', opts.difficulty ?? 'operator');
  run.legIndex = opts.legIndex;
  run.legProgress = 0;
  run.policy = { pace: opts.pace ?? 'steady', rations: opts.rations ?? 'standard', degreeOfMultiprogramming: opts.degree ?? DEFAULT_DEGREE };
  if (opts.ledger !== undefined) {
    for (const key of LEDGER_KEYS) {
      const value = opts.ledger[key];
      if (value !== undefined) run.resources[key] = value;
    }
  }
  if (opts.decisions !== undefined) run.decisions = opts.decisions.map((record) => ({ ...record }));
  if (opts.convoy !== undefined) {
    for (const patch of opts.convoy) {
      const member = run.convoy.find((candidate) => candidate.id === patch.id);
      if (member === undefined) throw new Error(`makeRunState: no convoy member ${String(patch.id)}`);
      const { afflictions, epitaph, ...rest } = patch;
      Object.assign(member, rest);
      if (afflictions !== undefined) member.afflictions = afflictions.map((affliction) => ({ ...affliction, remedy: { ...affliction.remedy } }));
      if (epitaph !== undefined) member.epitaph = epitaph === null ? null : { ...epitaph };
    }
  }
  return run;
}

/** LUMEN, SABLE, ORRERY, KESTREL and VESPER at 100 integrity with no afflictions, in that order. */
export function makeConvoy(): ConvoyMember[] {
  return initialRunState(0, 'shell', 'operator').convoy;
}

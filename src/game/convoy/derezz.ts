import type { ConvoyMemberId, Rng, TerminationReason, Tick } from '@kernel/index';
import type { ConvoyMember, Epitaph, LegId } from '../types';

export interface EpitaphTemplate {
  readonly id: string;
  readonly reason: TerminationReason;
  readonly inscription: string;
  readonly cause: string;
  readonly codexEntry: string;
  readonly member?: ConvoyMemberId;
  readonly legId?: LegId;
}
export interface EpitaphCopySource {
  templates(reason: TerminationReason): readonly EpitaphTemplate[];
}
export const defaultEpitaphCopySource: EpitaphCopySource = {
  templates() {
    // TODO(astra): epitaph copy package transcribes narrative 9
    throw new Error('Epitaph copy source must be supplied by the epitaph content package');
  },
};
export interface DerezzInput {
  readonly member: ConvoyMember;
  readonly reason: TerminationReason;
  readonly tick: Tick;
  readonly legId: LegId;
}
/** Pure builder. The caller supplies run/leg and mutates the roster and tombstones. */
export function derezz(input: DerezzInput, copy: EpitaphCopySource, rng: Pick<Rng, 'int'>): Epitaph {
  const { member, reason, tick, legId } = input;
  const candidates = copy.templates(reason).filter(template => template.reason === reason
    && (template.member === undefined || template.member === member.id)
    && (template.legId === undefined || template.legId === legId));
  if (candidates.length === 0) throw new Error(`No epitaph template for ${reason}, ${member.id}, ${legId}`);
  const template = candidates[rng.int(0, candidates.length)];
  if (template === undefined) throw new Error('Epitaph RNG returned an out-of-range index');
  return { member: member.id, reason, tick, legId,
    inscription: template.inscription.replaceAll('{NAME}', member.name),
    cause: template.cause.replaceAll('{NAME}', member.name), codexEntry: template.codexEntry };
}
/** Caller must terminate a still-live bound pid before releasing it, and append once. */
export function derezzMember(member: ConvoyMember, epitaph: Epitaph): void {
  member.integrity = 0;
  member.status = 'derezzed';
  member.pid = null;
  member.epitaph = epitaph;
}

import type { ConvoyMemberId, InvariantView } from '@kernel/index';
import type { DifficultyTier, DiscClass, ResourceLedger, RunState } from '../types';
import { applyDelta, refillBandwidth } from '../travel/ledger';
import { DEPOT_ITEMS, depotPrice, type DepotItemId } from './prices';

export type { DepotItemId } from './prices';

export interface DepotOffer {
  readonly item: DepotItemId;
  readonly cycles: number;
  readonly blocks: number;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface PurchaseResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly spent: Partial<ResourceLedger>;
  readonly gained: Partial<ResourceLedger>;
}

export interface DepotSnapshot {
  readonly criticalAtEntry: readonly ConvoyMemberId[];
  readonly repaired: readonly { readonly member: ConvoyMemberId; readonly points: number }[];
  readonly hintPurchased: boolean;
  readonly checkpointPurchased: boolean;
  readonly hint: string | null;
}

export interface DepotDeps {
  readonly getRun: () => Readonly<RunState>;
  readonly mutate: (recipe: (run: RunState) => void) => void;
  readonly view: () => InvariantView;
  readonly hasRecruited: () => boolean;
  /** The runner owns the replacement's once-per-run flag and passive side table. */
  readonly recruit: (member: ConvoyMemberId) => void;
  readonly checkpoint: () => void;
  readonly record: (item: DepotItemId, target: ConvoyMemberId | null, ok: boolean) => void;
}

/** Narrative 10.5: a measurement, with the additional remedy only at novice. */
export function policyHint(view: InvariantView, tier: DifficultyTier): string {
  const longest = Math.max(0, ...view.processes.filter((process) => process.state === 'ready' && process.readySince !== null).map((process) => view.tick - (process.readySince ?? view.tick)));
  const fact = `Scheduler: ${view.schedulerId}. agingInterval: ${view.schedulerParams.agingInterval}. Longest current ready wait: ${longest} ticks. Starvation fatal threshold: ${view.schedulerParams.starvationFatalThreshold}.`;
  return tier === 'novice' ? `${fact} Remedy for starvation: enable priority aging.` : fact;
}

export class Depot {
  private criticalAtEntry: Set<ConvoyMemberId>;
  private repaired = new Map<ConvoyMemberId, number>();
  private hintPurchased = false;
  private checkpointPurchased = false;
  private purchasedHint: string | null = null;

  constructor(readonly legIndex: number, readonly tier: DifficultyTier, readonly disc: DiscClass, private readonly deps: DepotDeps) {
    this.criticalAtEntry = new Set(deps.getRun().convoy.filter((member) => member.status !== 'derezzed' && member.integrity < 25).map((member) => member.id));
    deps.mutate((run) => refillBandwidth(run.resources, disc, tier, true));
  }

  get hint(): string | null { return this.purchasedHint; }

  snapshot(): DepotSnapshot {
    return {
      criticalAtEntry: [...this.criticalAtEntry].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      repaired: [...this.repaired].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([member, points]) => ({ member, points })),
      hintPurchased: this.hintPurchased, checkpointPurchased: this.checkpointPurchased, hint: this.purchasedHint,
    };
  }

  restore(state: DepotSnapshot): void {
    this.criticalAtEntry = new Set(state.criticalAtEntry);
    this.repaired = new Map(state.repaired.map(({ member, points }) => [member, points]));
    this.hintPurchased = state.hintPurchased;
    this.checkpointPurchased = state.checkpointPurchased;
    this.purchasedHint = state.hint;
  }

  catalogue(): readonly DepotOffer[] {
    return DEPOT_ITEMS.map((item) => {
      const cost = depotPrice(item, this.legIndex, this.tier);
      const blocks = item === 'repair' && this.disc === 'daemon' ? Math.ceil(cost.blocks / 2) : cost.blocks;
      const unavailableReason = this.unavailable(item);
      return { item, cycles: cost.cycles, blocks, available: unavailableReason === null, unavailableReason };
    });
  }

  private repairable(id: ConvoyMemberId): boolean {
    const member = this.deps.getRun().convoy.find((candidate) => candidate.id === id);
    return member !== undefined && member.status !== 'derezzed' && member.integrity < 100 && (!this.criticalAtEntry.has(id) || (this.repaired.get(id) ?? 0) < 30);
  }

  private unavailable(item: DepotItemId): string | null {
    if (item === 'policy_hint') {
      if (this.tier === 'kernel_space') return 'Policy hints are unavailable at kernel_space.';
      if (this.hintPurchased) return 'The policy hint has already been purchased at this depot.';
    }
    if (item === 'journal_checkpoint') {
      if (this.tier === 'kernel_space') return 'Journal checkpoints are unavailable at kernel_space.';
      if (this.checkpointPurchased) return 'The checkpoint has already been purchased at this depot.';
    }
    if (item === 'recruit') {
      if (this.deps.hasRecruited()) return 'The run has already recruited a replacement Program.';
      if (!this.deps.getRun().convoy.some((member) => member.status === 'derezzed')) return 'No Program needs a replacement.';
    }
    if (item === 'repair' && !this.deps.getRun().convoy.some((member) => this.repairable(member.id))) return 'No Program can be repaired at this depot.';
    return null;
  }

  /** The codec warning is available before purchase, including in a stale catalogue. */
  recruitNotice(target: ConvoyMemberId): string | null {
    return this.deps.getRun().convoy.find((member) => member.id === target)?.role === 'codec'
      ? 'The replacement restores the restore ability. Corruption remains unrecoverable; the codec passive does not return.' : null;
  }

  buy(item: DepotItemId, target: ConvoyMemberId | null): PurchaseResult {
    const offer = this.catalogue().find((candidate) => candidate.item === item);
    let reason = offer?.unavailableReason ?? null;
    if (offer === undefined) reason = 'Unknown depot item.';
    if (reason === null && item === 'repair' && (target === null || !this.repairable(target))) reason = 'Choose a living Program within its repair cap.';
    if (reason === null && item === 'recruit' && (target === null || !this.deps.getRun().convoy.some((member) => member.id === target && member.status === 'derezzed'))) reason = 'Choose a derezzed Program to replace.';
    const ledger = this.deps.getRun().resources;
    if (reason === null && offer !== undefined && (ledger.cycles < offer.cycles || ledger.blocks < offer.blocks)) reason = 'Insufficient cycles or blocks.';
    if (reason !== null || offer === undefined) {
      this.deps.record(item, target, false);
      return { ok: false, reason, spent: {}, gained: {} };
    }
    const gained: Partial<ResourceLedger> = item === 'quota_lot' ? { quota: 25 } : item === 'block_lot' ? { blocks: 10 } : item === 'bandwidth_lot' ? { bandwidth: 5 } : {};
    this.deps.mutate((run) => {
      applyDelta(run.resources, { cycles: -offer.cycles, blocks: -offer.blocks });
      applyDelta(run.resources, gained);
      if (item === 'repair' && target !== null) {
        const member = run.convoy.find((candidate) => candidate.id === target);
        if (member !== undefined) {
          const restored = Math.min(10, 100 - member.integrity, this.criticalAtEntry.has(target) ? 30 - (this.repaired.get(target) ?? 0) : 10);
          member.integrity += restored;
          member.status = member.integrity >= 70 ? 'nominal' : member.integrity >= 25 ? 'degraded' : 'critical';
          this.repaired.set(target, (this.repaired.get(target) ?? 0) + restored);
        }
      }
    });
    if (item === 'policy_hint') { this.purchasedHint = policyHint(this.deps.view(), this.tier); this.hintPurchased = true; }
    if (item === 'journal_checkpoint') { this.checkpointPurchased = true; this.deps.checkpoint(); }
    if (item === 'recruit' && target !== null) this.deps.recruit(target);
    this.deps.record(item, target, true);
    return { ok: true, reason: null, spent: { cycles: offer.cycles, blocks: offer.blocks }, gained };
  }
}

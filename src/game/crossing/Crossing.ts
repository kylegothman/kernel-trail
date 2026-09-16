import type { ConvoyMemberId, InvariantView, Rng, TerminationReason, Tick } from '@kernel/index';
import type { AfflictionId, DecisionRecord, LegId, ResourceLedger, RunState } from '../types';
import { applyDelta } from '../travel/ledger';
import { contention } from './contention';
import { quote, type CrossingContext, type CrossingOption, type CrossingQuote } from './options';

export interface CrossingDef {
  readonly id: string;
  readonly legId: LegId;
  readonly lockId: string;
  readonly kind: 'mutex' | 'semaphore' | 'monitor' | 'rwlock';
  readonly ordered: boolean;
  readonly anchor: string;
  readonly crosser: ConvoyMemberId | null;
}

export interface CrossingResult {
  readonly def: CrossingDef;
  readonly option: CrossingOption;
  readonly contentionAtChoice: number;
  readonly quote: CrossingQuote;
  readonly succeeded: boolean;
  readonly attempts: number;
  readonly afflicted: readonly { readonly member: ConvoyMemberId; readonly id: AfflictionId }[];
  readonly casualties: readonly ConvoyMemberId[];
  readonly eventsDrawn: readonly string[];
  readonly spent: Partial<ResourceLedger>;
  readonly refused: string | null;
}

export interface CrossingDeps {
  readonly getRun: () => Readonly<RunState>;
  readonly mutate: (recipe: (run: RunState) => void) => void;
  readonly view: () => InvariantView;
  readonly rng: Rng;
  /** The director advances its ordinary kernel/affliction path with travel prepaid. */
  readonly step: () => boolean | void;
  readonly drawEvent: () => string | null;
  readonly inflict: (member: ConvoyMemberId, id: AfflictionId, at: Tick) => void;
  readonly derezz: (member: ConvoyMemberId, reason: TerminationReason, at: Tick) => void;
  readonly record: (choice: string, outcome: DecisionRecord['outcome'], at: Tick) => void;
}

export class CrossingRunner {
  constructor(private readonly deps: CrossingDeps) {}

  survey(def: CrossingDef): CrossingContext {
    const view = this.deps.view();
    const lock = view.syncPrimitives.find((primitive) => primitive.id === def.lockId);
    if (lock === undefined) throw new Error(`Unknown crossing lock: ${def.lockId}`);
    const run = this.deps.getRun();
    const living = run.convoy.filter((member) => member.status !== 'derezzed').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const crosser = def.crosser === null ? living[0] : living.find((member) => member.id === def.crosser);
    const crosserPid = crosser?.pid;
    const process = view.processes.find((candidate) => candidate.pid === crosser?.pid);
    return {
      contention: contention(view, lock), ordered: lock.ordered,
      rations: run.policy.rations, aliveCount: run.convoy.filter((member) => member.status !== 'derezzed').length,
      crosserHoldsResource: process?.heldResources.some((id) => id !== lock.id) === true || (crosserPid !== null && crosserPid !== undefined && view.syncPrimitives.some((primitive) => primitive.id !== lock.id && primitive.holders.includes(crosserPid))),
    };
  }

  resolve(def: CrossingDef, option: CrossingOption, at: Tick): CrossingResult {
    const initial = this.survey(def);
    const initialQuote = quote(option, initial);
    const aliveBefore = this.deps.getRun().convoy.filter((member) => member.status !== 'derezzed').map((member) => member.id);
    const afflicted: { member: ConvoyMemberId; id: AfflictionId }[] = [];
    const eventsDrawn: string[] = [];
    const spent: ResourceLedger = { cycles: 0, quota: 0, blocks: 0, bandwidth: 0 };
    let attempts = 0;
    let succeeded = false;
    let refused: string | null = null;
    const inflict = (member: ConvoyMemberId, id: AfflictionId): void => {
      if (!this.deps.getRun().convoy.some((candidate) => candidate.id === member && candidate.status !== 'derezzed')) return;
      this.deps.inflict(member, id, this.deps.view().tick);
      afflicted.push({ member, id });
    };
    while (attempts < 4 && !succeeded) {
      const live = this.deps.getRun().convoy.filter((member) => member.status !== 'derezzed').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const crosser = def.crosser === null ? live[0] : live.find((member) => member.id === def.crosser);
      if (crosser === undefined) break;
      const context = this.survey(def);
      const cost = quote(option, context);
      const ledger = this.deps.getRun().resources;
      if (ledger.cycles < cost.cyclesCost || ledger.quota < cost.quotaCost || ledger.bandwidth < cost.bandwidthCost || ledger.blocks < cost.blocksCost) {
        refused = 'Insufficient resources for the crossing attempt.';
        break;
      }
      this.deps.mutate((run) => applyDelta(run.resources, { cycles: -cost.cyclesCost, quota: -cost.quotaCost, bandwidth: -cost.bandwidthCost, blocks: -cost.blocksCost }));
      spent.cycles += cost.cyclesCost; spent.quota += cost.quotaCost;
      spent.bandwidth += cost.bandwidthCost; spent.blocks += cost.blocksCost;
      attempts += 1;
      let halted = false;
      for (let step = 1; step <= cost.ticksCost; step++) {
        if (this.deps.getRun().convoy.every((member) => member.status === 'derezzed')) { halted = true; break; }
        // A director guard can stop the simulation without inventing a roll.
        if (this.deps.step() === false) { halted = true; break; }
        if (option === 'wait' && step % 10 === 0) {
          const event = this.deps.drawEvent();
          if (event !== null) eventsDrawn.push(event);
        }
      }
      if (halted) break;
      succeeded = this.deps.rng.next() < cost.successP;
      if (!succeeded) {
        if (option === 'spin') {
          if (context.contention <= 0.70) {
            const convoy = [...this.deps.getRun().convoy].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            for (const member of convoy.slice(convoy.findIndex((candidate) => candidate.id === crosser.id))) inflict(member.id, 'lock_convoy');
          } else {
            inflict(crosser.id, 'livelock');
            const others = this.deps.getRun().convoy.filter((member) => member.status !== 'derezzed' && member.id !== crosser.id).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            if (others.length > 0) {
              const other = others[this.deps.rng.int(0, others.length)];
              if (other !== undefined) inflict(other.id, 'livelock');
            }
          }
        } else if (option === 'block') inflict(crosser.id, 'starvation');
        else if (option === 'monitor') {
          const lost = Math.min(20, this.deps.getRun().resources.blocks);
          this.deps.mutate((run) => applyDelta(run.resources, { blocks: -20 }));
          spent.blocks += lost;
          inflict(crosser.id, 'bit_rot');
        }
      }
      // The hold-and-wait roll is independent of the bounded-waiting roll.
      if (option === 'block' && context.contention > 0.75 && context.crosserHoldsResource && this.deps.rng.next() < 0.12) {
        this.deps.derezz(crosser.id, 'deadlock_victim', this.deps.view().tick);
      }
      if (!this.deps.getRun().convoy.some((member) => member.id === crosser.id && member.status !== 'derezzed')) {
        succeeded = false;
        break;
      }
    }
    const casualties = aliveBefore.filter((id) => this.deps.getRun().convoy.some((member) => member.id === id && member.status === 'derezzed'));
    this.deps.record(`${def.id}:${option}`, casualties.length > 0 ? 'fatal' : succeeded ? 'good' : 'costly', at);
    return { def, option, contentionAtChoice: initial.contention, quote: initialQuote, succeeded, attempts, afflicted, casualties, eventsDrawn, spent, refused };
  }
}

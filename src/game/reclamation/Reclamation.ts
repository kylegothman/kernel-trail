import type { ConvoyMemberId, Rng } from '@kernel/index';
import type { DifficultyTier, RunState } from '../types';
import { applyDelta } from '../travel/ledger';
import { generateVerge, type VergeLayout } from './verge';
import { scoreReclamation, type ReclamationYield } from './scoring';

export type ReclamationTrace = readonly { readonly atSeconds: number; readonly action: 'collect' | 'coalesce'; readonly blockId: number }[];

export interface ReclamationDeps {
  readonly getRun: () => Readonly<RunState>;
  readonly mutate: (recipe: (run: RunState) => void) => void;
  readonly rng: Rng;
  readonly onIntegrity: (member: ConvoyMemberId, amount: number) => void;
  readonly record: (trace: ReclamationTrace, runIndex: number) => void;
}

export interface ReclamationResult {
  readonly yield: ReclamationYield;
  readonly liveHits: readonly ConvoyMemberId[];
  readonly lightingBlankedUntil: number;
}

export interface ReclamationSnapshot {
  readonly layout: VergeLayout | null;
  readonly runIndex: number;
  readonly submitted: boolean;
}

export class Reclamation {
  private layout: VergeLayout | null = null;
  private runIndex = 0;
  private submitted = false;

  constructor(private readonly deps: ReclamationDeps) {}

  snapshot(): ReclamationSnapshot { return { layout: this.layout, runIndex: this.runIndex, submitted: this.submitted }; }
  restore(state: ReclamationSnapshot): void { this.layout = state.layout; this.runIndex = state.runIndex; this.submitted = state.submitted; }

  open(f: number, tier: DifficultyTier, runIndex: number): VergeLayout {
    if (this.layout !== null) throw new Error('A reclamation round is already open.');
    if (!Number.isInteger(runIndex) || runIndex < 1 || runIndex > 3) throw new RangeError('Only three reclamation rounds are allowed per leg.');
    if (runIndex !== this.runIndex + 1) throw new Error('Reclamation rounds must advance in order within the leg.');
    if (runIndex > 1 && this.deps.getRun().resources.bandwidth < 8) throw new Error('Insufficient bandwidth for another reclamation round.');
    const layout = generateVerge(f, this.deps.rng, tier);
    if (runIndex > 1) this.deps.mutate((run) => applyDelta(run.resources, { bandwidth: -8 }));
    this.layout = layout; this.runIndex = runIndex; this.submitted = false;
    return layout;
  }

  submit(trace: ReclamationTrace): ReclamationResult {
    const layout = this.layout;
    if (layout === null || this.submitted) throw new Error('A reclamation round accepts one trace while open.');
    let previous = 3;
    const used = new Set<number>();
    // Validate before mutating: malformed traces cannot take partial penalties or yield.
    for (const action of trace) {
      if (!Number.isFinite(action.atSeconds) || action.atSeconds < previous || action.atSeconds > layout.seconds) throw new Error('Reclamation actions must be ordered within the sweep phase.');
      if (used.has(action.blockId)) throw new Error('A reclamation target may be collected only once.');
      const fragment = layout.fragments.some((target) => target.id === action.blockId);
      const block = layout.leaked.some((target) => target.id === action.blockId) || layout.live.some((target) => target.id === action.blockId);
      if ((!fragment && !block) || (action.action === 'coalesce' && !fragment)) throw new Error('Invalid reclamation action target.');
      used.add(action.blockId); previous = action.atSeconds;
    }
    let leakedFrames = 0;
    let fragmentsCollected = 0;
    let liveBlocksReclaimed = 0;
    let longestUnbrokenChain = 0;
    let chain = 0;
    let previousFragment: number | null = null;
    let lightingBlankedUntil = 0;
    const liveHits: ConvoyMemberId[] = [];
    for (const action of trace) {
      const fragment = layout.fragments.find((target) => target.id === action.blockId);
      if (fragment !== undefined) {
        fragmentsCollected += 1;
        chain = action.action === 'coalesce' && previousFragment !== null && fragment.adjacent.includes(previousFragment) ? chain + 1 : 1;
        previousFragment = action.action === 'coalesce' ? fragment.id : null;
        longestUnbrokenChain = Math.max(longestUnbrokenChain, chain);
      } else {
        chain = 0; previousFragment = null;
        const leaked = layout.leaked.find((target) => target.id === action.blockId);
        if (leaked !== undefined) leakedFrames += leaked.frames;
        else {
          liveBlocksReclaimed += 1;
          lightingBlankedUntil = action.atSeconds + 4;
          const living = this.deps.getRun().convoy.filter((member) => member.status !== 'derezzed').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          if (living.length > 0) {
            const target = living[this.deps.rng.int(0, living.length)];
            if (target !== undefined) { this.deps.onIntegrity(target.id, 6); liveHits.push(target.id); }
          }
        }
      }
    }
    const yieldValue = scoreReclamation({ leakedFrames, fragmentsCollected, longestUnbrokenChain, liveBlocksReclaimed }, this.deps.getRun().discClass, this.runIndex);
    this.deps.mutate((run) => applyDelta(run.resources, { quota: yieldValue.quota, blocks: yieldValue.blocks, cycles: yieldValue.cycles }));
    this.submitted = true;
    this.deps.record(trace, this.runIndex);
    return { yield: yieldValue, liveHits, lightingBlankedUntil };
  }

  close(): void { this.layout = null; this.submitted = false; }
}

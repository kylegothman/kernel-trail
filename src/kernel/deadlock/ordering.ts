import type { DeadlockSnapshotState, ResourceId } from '../types';
import type { ResourceVector } from './resources';

export type ResourceRank = DeadlockSnapshotState['payload']['ranks'][number];

/** Ch. 8.5.4. Rank follows declaration order, independent of matrix columns. */
export class ResourceOrdering {
  private readonly ordered: ResourceRank[] = [];
  private readonly ranks = new Map<ResourceId, number>();

  declare(resource: ResourceId, source: ResourceRank['source']): number {
    if (this.ranks.has(resource)) throw new RangeError(`duplicate ranked resource ${resource}`);
    const rank = this.ordered.length;
    this.ordered.push(Object.freeze({ resource, source }));
    this.ranks.set(resource, rank);
    return rank;
  }

  rank(resource: ResourceId): number | undefined { return this.ranks.get(resource); }
  entries(): readonly ResourceRank[] { return this.ordered.map(entry => ({ ...entry })); }

  checkOrdering(held: readonly ResourceId[], requested: readonly ResourceId[]): boolean {
    let highestHeld = -1;
    for (const id of held) {
      const rank = this.rank(id);
      if (rank === undefined) return false;
      highestHeld = Math.max(highestHeld, rank);
    }
    return requested.every(id => {
      const rank = this.rank(id);
      return rank !== undefined && rank > highestHeld;
    });
  }

  /** Ch. 8.5.2. A complete claim is acquired atomically from a resource-free state. */
  checkAllOrNothing(held: readonly ResourceId[], requested: ResourceVector, claim: ResourceVector): boolean {
    if (held.length !== 0 || requested.length !== claim.length) return false;
    const amounts = new Map(claim);
    if (amounts.size !== claim.length || new Set(requested.map(([id]) => id)).size !== requested.length) return false;
    return requested.every(([id, count]) => this.ranks.has(id) && Number.isSafeInteger(count) && count > 0 && amounts.get(id) === count);
  }

  restore(entries: readonly ResourceRank[]): void {
    const staged = new ResourceOrdering();
    for (const entry of entries) {
      if (entry.source !== 'resource' && entry.source !== 'sync') throw new RangeError('invalid rank source');
      staged.declare(entry.resource, entry.source);
    }
    this.ordered.splice(0, this.ordered.length, ...staged.ordered);
    this.ranks.clear();
    for (const [id, rank] of staged.ranks) this.ranks.set(id, rank);
  }
}

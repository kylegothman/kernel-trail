import type { PageId, Rng } from '../types';
import { asPageId } from '../types';

export interface LocalityOptions {
  readonly localitySize?: number;
  readonly localityShiftChance?: number;
  readonly writeRatio?: number;
}

/** All decisions consume the supplied shared VM stream, in reference order. */
export class LocalityGenerator {
  readonly effectiveSize: number;
  private base = 0;
  private shifts = 0;
  private readonly shiftChance: number;
  private readonly writes: number;

  constructor(private readonly rng: Rng, readonly pageCount: number, options: LocalityOptions = {}) {
    const size = options.localitySize ?? 4;
    if (!Number.isSafeInteger(pageCount) || pageCount < 0 || !Number.isSafeInteger(size) || size < 1) {
      throw new RangeError('invalid locality dimensions');
    }
    this.shiftChance = options.localityShiftChance ?? 0.02;
    this.writes = options.writeRatio ?? 0.3;
    for (const ratio of [this.shiftChance, this.writes]) {
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError('invalid locality probability');
    }
    this.effectiveSize = Math.min(size, pageCount);
  }

  get localityBase(): number { return this.base; }
  /** Decisions, including legal selections of the current base again. */
  get shiftDecisions(): number { return this.shifts; }

  next(): { readonly page: PageId; readonly write: boolean } | null {
    if (this.pageCount === 0) return null;
    if (this.rng.chance(this.shiftChance)) {
      this.base = this.rng.int(0, this.pageCount - this.effectiveSize + 1);
      this.shifts += 1;
    }
    const page = asPageId(this.base + this.rng.int(0, this.effectiveSize));
    return { page, write: this.rng.chance(this.writes) };
  }
}

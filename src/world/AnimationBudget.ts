import { PROFILES, type QualityTier } from '@platform';

export type AnimationClass = 'derezz' | 'beam' | 'element';
export interface AnimationBudgetDiagnostic { readonly cls: AnimationClass; readonly aggregated: number; readonly visible: number; }

export class AnimationBudget {
  readonly limits: Readonly<Record<AnimationClass, number>>;
  private readonly visible = { derezz: 0, beam: 0, element: 0 };
  private readonly aggregated = { derezz: 0, beam: 0, element: 0 };
  constructor(readonly tier: QualityTier) {
    const p = PROFILES[tier];
    this.limits = { derezz: p.concurrentDerezz, beam: p.concurrentBeams, element: p.animatedElements };
  }
  beginFrame(): void {
    this.visible.derezz = 0; this.visible.beam = 0; this.visible.element = 0;
    this.aggregated.derezz = 0; this.aggregated.beam = 0; this.aggregated.element = 0;
  }
  admit(cls: AnimationClass): boolean {
    if (this.visible[cls] < this.limits[cls]) { this.visible[cls] += 1; return true; }
    this.aggregated[cls] += 1;
    return false;
  }
  release(cls: AnimationClass): void { this.visible[cls] = Math.max(0, this.visible[cls] - 1); }
  aggregate(cls: AnimationClass, count = 1): void { this.aggregated[cls] += count; }
  diagnostics(): readonly AnimationBudgetDiagnostic[] {
    return (['derezz', 'beam', 'element'] as const).map((cls) => ({ cls, aggregated: this.aggregated[cls], visible: this.visible[cls] }));
  }
  get visibleCount(): number { return this.visible.element; }
  get aggregatedCount(): number { return this.aggregated.element; }
}

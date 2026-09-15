import { PROFILES, type QualityTier, type RenderQualityProfile } from './quality';
export interface GovernorFrameSample { readonly frameMs: number; readonly droppedTicks: number }
export interface GovernorOptions { readonly budgetMs: number; readonly consecutive: number; readonly cooldownFrames: number; readonly upgradeWindow: number }
export const DEFAULT_GOVERNOR: GovernorOptions = { budgetMs: 18.5, consecutive: 90, cooldownFrames: 600, upgradeWindow: 1800 };
const ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];
export class QualityGovernor {
  private over = 0;
  private under = 0;
  private cooldown = 0;
  private manual = false;
  constructor(private tier: QualityTier,
    private readonly apply: (profile: RenderQualityProfile, why: string) => void,
    private readonly offerUpgrade: (tier: QualityTier) => void,
    private readonly opts = DEFAULT_GOVERNOR) {}
  get current(): QualityTier { return this.tier; }
  setManual(tier: QualityTier): void { this.manual = true; this.tier = tier; this.pauseForTransition(); this.apply(PROFILES[tier], 'user'); }
  clearManual(): void { this.manual = false; this.pauseForTransition(); }
  pauseForTransition(): void { this.cooldown = this.opts.cooldownFrames; this.over = 0; this.under = 0; }
  onFrame(m: GovernorFrameSample, drawCallOverBudget: boolean): void {
    if (this.cooldown > 0) { this.cooldown--; return; }
    if (this.manual) return;
    if (m.frameMs > this.opts.budgetMs || drawCallOverBudget) { this.over += m.droppedTicks > 0 ? 3 : 1; this.under = 0; }
    else { this.under++; this.over = Math.max(0, this.over - 1); }
    if (this.over >= this.opts.consecutive) {
      const lower = ORDER[ORDER.indexOf(this.tier) - 1];
      this.pauseForTransition();
      if (lower !== undefined) { this.tier = lower; this.apply(PROFILES[lower], 'auto-downgrade'); }
      else this.apply({ ...PROFILES.low, renderScale: 0.6, maxPixelRatio: 1 }, 'auto-downgrade-floor');
    } else if (this.under >= this.opts.upgradeWindow) {
      this.under = 0;
      const higher = ORDER[ORDER.indexOf(this.tier) + 1];
      if (higher !== undefined) this.offerUpgrade(higher);
    }
  }
}

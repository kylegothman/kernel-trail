import { describe, expect, it } from 'vitest';
import { AnimationBudget } from '../../src/world/AnimationBudget';

describe('AnimationBudget', () => {
  it('aggregates over-ceiling treatments and reports each class', () => {
    const budget = new AnimationBudget('low');
    budget.beginFrame();
    for (let i = 0; i < 20; i += 1) expect(budget.admit('beam')).toBe(i < 16);
    expect(budget.diagnostics()).toContainEqual({ cls: 'beam', aggregated: 4, visible: 16 });
    budget.aggregate('derezz', 3);
    expect(budget.diagnostics()).toContainEqual({ cls: 'derezz', aggregated: 3, visible: 0 });
    budget.beginFrame();
    expect(budget.diagnostics().every((entry) => entry.aggregated === 0 && entry.visible === 0)).toBe(true);
  });
});

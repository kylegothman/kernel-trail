/**
 * WP-L03 stage: the leg describes where its structures stand as data, and
 * `createStage` is `layoutStage` over that data (scope correction section 2).
 * No renderer is involved, which is why these cases run headlessly.
 *
 * The package's draw-call budgets and its legibility check need a renderer and
 * a measured frame, so they belong to the render track's structure package and
 * are not asserted here. What a leg can prove is that every anchor the world
 * has to build is declared, named and reachable.
 */
import { describe, expect, it } from 'vitest';
import { layoutStage } from '@legs/layout';
import leg, { content } from '@legs/quantum_pass/index';
import { ANCHORS } from '@legs/quantum_pass/interactions';
import { CONVOY_ANCHORS, TIER_ANCHORS, WAIT_COUNTER_ANCHORS, layout } from '@legs/quantum_pass/stage';
import { makeRunState } from '../harness/makeRunState';

const run = makeRunState({ seed: 0x4b54524c, legIndex: 3 });
const stage = leg.createStage({ quality: 'low', run });

describe('the layout', () => {
  it('resolves every interaction anchor', () => {
    for (const def of leg.interactions) expect(stage.anchor(def.anchor), def.anchor).not.toBeNull();
  });

  it('resolves every declared anchor and nothing else', () => {
    for (const anchor of layout.anchors) expect(stage.anchor(anchor.id), anchor.id).toBe(anchor);
    expect(stage.anchor('anchor.nowhere')).toBeNull();
    expect(stage.anchor('')).toBeNull();
  });

  it('is layoutStage over the companion layout', () => {
    const direct = layoutStage(content.layout);
    for (const anchor of content.layout.anchors) expect(stage.anchor(anchor.id)).toBe(direct.anchor(anchor.id));
    expect(stage.update(0.016, 0.5)).toBeUndefined();
    expect(stage.dispose()).toBeUndefined();
  });

  it('carries the pass, the ledge, the control, the drum and the ribbon', () => {
    for (const id of Object.values(ANCHORS)) expect(stage.anchor(id), id).not.toBeNull();
  });

  it('carries three feedback queue tiers, one stele per Program and one wait counter per Program', () => {
    expect(TIER_ANCHORS).toHaveLength(3);
    expect(CONVOY_ANCHORS).toHaveLength(5);
    expect(WAIT_COUNTER_ANCHORS).toHaveLength(5);
    for (const id of [...TIER_ANCHORS, ...CONVOY_ANCHORS, ...WAIT_COUNTER_ANCHORS]) expect(stage.anchor(id), id).not.toBeNull();
    // The tiers descend: level 0 is the top of the pass and the longest quanta are at the bottom.
    const height = (id: string): number => (stage.anchor(id) as { position: readonly [number, number, number] }).position[1];
    expect(height('anchor.tier.0')).toBeGreaterThan(height('anchor.tier.1'));
    expect(height('anchor.tier.1')).toBeGreaterThan(height('anchor.tier.2'));
  });

  it('every camera target is an anchor, and every non-interaction anchor is an extra', () => {
    const ids = new Set(layout.anchors.map((anchor) => anchor.id));
    for (const target of layout.cameraTargets) expect(ids, target).toContain(target);
    const interactionAnchors = new Set(leg.interactions.map((def) => def.anchor));
    for (const anchor of layout.anchors) {
      if (interactionAnchors.has(anchor.id)) continue;
      expect(layout.extras, anchor.id).toContain(anchor.id);
    }
  });

  it('names a structure for every custom kind, since the registry has none of them', () => {
    const custom = layout.anchors.filter((anchor) => anchor.kind === 'custom');
    expect(custom.length).toBeGreaterThan(0);
    for (const anchor of custom) {
      expect(anchor.structure, anchor.id).toBeDefined();
      expect(anchor.structure?.length, anchor.id).toBeGreaterThan(0);
    }
    expect([...new Set(custom.map((anchor) => anchor.structure))].sort()).toEqual(['GanttRibbon', 'QuantumDrum', 'WaitCounter']);
  });

  it('declares no anchor twice and gives each a position', () => {
    const ids = layout.anchors.map((anchor) => anchor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const anchor of layout.anchors) expect(anchor.position, anchor.id).toHaveLength(3);
  });

  it('builds the same stage at every quality tier, because a layout carries no quality', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const built = leg.createStage({ quality, run });
      expect(built.anchor(ANCHORS.ganttWall)).toBe(stage.anchor(ANCHORS.ganttWall));
      built.dispose();
    }
  });
});

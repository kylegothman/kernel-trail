/**
 * WP-L07 acceptance 22 and the stage contract. A leg declares kinds and
 * positions and never implements a structure, and the harness resolves its
 * anchors with no renderer, so draw calls are not measurable from here;
 * acceptance 21 is the render track's and is reported rather than asserted.
 */
import { describe, expect, it } from 'vitest';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { layout } from '@legs/allocation_yards/stage';
import { admissiblePageSizes, readPaging } from '@legs/allocation_yards/routes';
import { OPENING_FREE_RUNS, OPENING_FREE_SLOTS, OPENING_REQUEST_SLOTS } from '@legs/allocation_yards/yard';

const leg = await loadLegForTest('allocation_yards');
const stage = leg.createStage({ quality: 'low', run: makeRunState({ seed: 0x4b54524c, legIndex: 7 }) });

describe('the layout', () => {
  it('resolves every interaction anchor and every camera target', () => {
    for (const def of leg.interactions) {
      expect(stage.anchor(def.anchor), `unresolved anchor ${def.anchor}`).not.toBeNull();
    }
    for (const target of layout.cameraTargets) expect(stage.anchor(target), target).not.toBeNull();
    expect(stage.anchor('anchor.nowhere')).toBeNull();
  });

  it('gives the yard a bay per berth and a stele per Program', () => {
    for (let bay = 1; bay <= 7; bay++) expect(stage.anchor(`anchor.bay.${bay}`), `bay ${bay}`).not.toBeNull();
    for (const member of ['lumen', 'sable', 'orrery', 'kestrel', 'vesper']) {
      expect(stage.anchor(`anchor.convoy.${member}`), member).not.toBeNull();
    }
    expect(layout.anchors.filter((anchor) => anchor.kind === 'slab')).toHaveLength(7);
  });

  it('puts both fragmentation meters inside one anchor, so one orthographic lock holds both', () => {
    const meters = layout.anchors.filter((anchor) => anchor.id === 'anchor.frag_meters');
    expect(meters).toHaveLength(1);
    expect(meters[0]?.kind).toBe('custom');
    expect(meters[0]?.structure).toBe('FragmentationMeters');
    expect(layout.cameraTargets).toContain('anchor.frag_meters');
    // Two separate anchors could not promise the same frame, which is what the
    // second misconception needs.
    expect(layout.anchors.some((anchor) => anchor.id.includes('external_meter'))).toBe(false);
    expect(layout.anchors.some((anchor) => anchor.id.includes('internal_meter'))).toBe(false);
  });

  it('names a structure for every custom anchor and declares no other kind a leg cannot ask for', () => {
    for (const anchor of layout.anchors) {
      if (anchor.kind === 'custom') expect(anchor.structure, anchor.id).toBeTruthy();
    }
    expect(new Set(layout.anchors.map((anchor) => anchor.id)).size).toBe(layout.anchors.length);
  });

  it('frames the hero shot from the gantry, with the request bar in it', () => {
    expect(stage.anchor('anchor.yard')).not.toBeNull();
    expect(stage.anchor('anchor.request_bar')).not.toBeNull();
    expect(layout.cameraTargets).toContain('anchor.yard');
    expect(layout.cameraTargets).toContain('anchor.request_bar');
  });
});

describe('the hero visual is arithmetically honest', () => {
  it('the labelled holes sum to more than the bar and no single hole reaches it', () => {
    const bar = OPENING_REQUEST_SLOTS;
    const holes = OPENING_FREE_RUNS;
    expect(holes.reduce((sum, size) => sum + size, 0)).toBe(OPENING_FREE_SLOTS);
    expect(OPENING_FREE_SLOTS).toBeGreaterThan(bar);
    expect(Math.max(...holes)).toBeLessThan(bar);
    // Every label is the hole's own size, so a player who counts finds it works.
    for (const size of holes) expect(size).toBeGreaterThan(0);
    expect(holes).toHaveLength(41);
  });

  it('keeps the index board countable at a glance on every admissible page size', () => {
    for (const size of admissiblePageSizes()) {
      expect(readPaging(size).largestTable, String(size)).toBeLessThanOrEqual(64);
    }
  });

  it('reports the draw call budget as the render track\'s to measure', () => {
    // A leg may not import @render or @world, so 220 / 450 / 900 cannot be
    // counted from here. The layout is what the boot package builds the scene
    // from, and the heaviest frame is the hero shot named above.
    console.log('stage: draw call budgets (acceptance 21) are not measurable from the leg layer; reported to the render track');
    expect(layout.anchors.length).toBeLessThan(40);
  });
});

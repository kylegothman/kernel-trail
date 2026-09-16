/**
 * The stage as data: every anchor the package's table names resolves, every
 * interaction anchor resolves, the layout validates, and the event table is
 * well formed. Draw calls (acceptance 13) and the beat timings (14, 15) are
 * the boot package's to measure; a leg holds no renderer (scope correction 2).
 */
import { describe, expect, it } from 'vitest';
import { validateTable } from '@game/events/EventDeck';
import { bootSector, content } from './leg';
import { ANCHORS } from '@legs/boot_sector/interactions';
import { ONBOARDING } from '@legs/boot_sector/onboarding';
import { anchors, layout } from '@legs/boot_sector/stage';
import { WINDOWS } from '@legs/boot_sector/windows';
import { makeRunState } from '../harness/makeRunState';

const PACKAGE_ANCHORS = [
  'anchor.plate', 'anchor.cpu_pillar', 'anchor.depot',
  'anchor.win.quota', 'anchor.win.blocks', 'anchor.win.bandwidth', 'anchor.win.manifest', 'anchor.win.identity', 'anchor.win.priority',
  'anchor.block_stack', 'anchor.disc_plinth',
  'anchor.convoy.lumen', 'anchor.convoy.sable', 'anchor.convoy.orrery', 'anchor.convoy.kestrel', 'anchor.convoy.vesper',
  'anchor.ring_stack',
];

describe('boot_sector stage', () => {
  it('resolves every anchor in the package table and every interaction anchor, with no renderer', () => {
    const stage = bootSector.createStage({ quality: 'low', run: makeRunState({ seed: 1, legIndex: 0 }) });
    for (const id of PACKAGE_ANCHORS) expect(stage.anchor(id), id).not.toBeNull();
    for (const def of bootSector.interactions) expect(stage.anchor(def.anchor), def.id).not.toBeNull();
    expect(stage.anchor('anchor.nowhere')).toBeNull();
    expect(anchors.map((anchor) => anchor.id).sort()).toEqual([...PACKAGE_ANCHORS].sort());
    stage.dispose();
  });

  it('places the windows in a row on the depot face and the stele on the module ring', () => {
    for (const def of WINDOWS) expect(layout.cameraTargets).toContain(def.anchor);
    const stele = anchors.filter((anchor) => anchor.id.startsWith('anchor.convoy.'));
    for (const anchor of stele) expect(Math.hypot(anchor.position[0], anchor.position[2])).toBeCloseTo(4, 9);
    expect(layout.cameraTargets).not.toContain(ANCHORS.plate);
    expect(layout.cameraTargets).not.toContain(ANCHORS.blockStack);
    expect(layout.cameraTargets).not.toContain(ANCHORS.ringStack);
    for (const anchor of anchors) if (anchor.kind === 'custom') expect(anchor.structure, anchor.id).toMatch(/^[A-Z]/);
    expect(content.layout).toBe(layout);
  });

  it('the event table sums to 100 with unique ids and no affliction', () => {
    expect(validateTable(bootSector.eventTable)).toEqual([]);
    expect(bootSector.eventTable.reduce((sum, def) => sum + def.weight, 0)).toBe(100);
    expect(new Set(bootSector.eventTable.map((def) => def.id)).size).toBe(7);
    for (const def of bootSector.eventTable) expect(def.inflicts, def.id).toBeNull();
    expect(bootSector.eventTable.find((def) => def.id === 'boot.vendor_string')?.targets).toBe('cartographer');
  });

  it('the onboarding sequence is eight beats with one timed beat', () => {
    expect(ONBOARDING).toHaveLength(8);
    expect(ONBOARDING.filter((beat) => beat.durationMs !== null).map((beat) => beat.id)).toEqual(['beat.void']);
    expect(ONBOARDING.map((beat) => beat.id)).toEqual(['beat.void', 'beat.floor', 'beat.convoy', 'beat.reach', 'beat.terminal', 'beat.trap', 'beat.batching', 'beat.gate']);
  });
});

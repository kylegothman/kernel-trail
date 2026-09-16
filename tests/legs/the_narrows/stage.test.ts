/**
 * WP-L04: the layout. A leg declares where its structures stand and never
 * implements one, so what is checkable here is that every anchor an
 * interaction, a crossing or the focus camera names is present, that the four
 * structures the registry does not have are declared `custom` with the name it
 * must supply, and that building the stage pulls no renderer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import theNarrows, { content } from '@legs/the_narrows';
import { crossings } from '@legs/the_narrows/crossings';
import { layout } from '@legs/the_narrows/stage';
import { REPO_ROOT, scanForbiddenImports } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';

const stage = (): ReturnType<typeof theNarrows.createStage> =>
  theNarrows.createStage({ quality: 'low', run: makeRunState({ seed: 1, legIndex: 4 }) });

describe('the canyon', () => {
  it('resolves every anchor an interaction names', () => {
    const built = stage();
    for (const interaction of theNarrows.interactions) {
      expect(built.anchor(interaction.anchor), interaction.id).not.toBeNull();
    }
    built.dispose();
  });

  it('resolves every anchor a crossing stands at', () => {
    const built = stage();
    for (const def of crossings) expect(built.anchor(def.anchor), def.id).not.toBeNull();
    built.dispose();
  });

  it('carries the posts, the stone, the readout and a stele for each Program', () => {
    const ids = new Set(layout.anchors.map((anchor) => anchor.id));
    for (const id of ['anchor.canyon', 'anchor.plank', 'anchor.ledger_post.near', 'anchor.ledger_post.far',
      'anchor.turnstile', 'anchor.contention_readout', 'anchor.second_ford', 'anchor.wide_ford',
      'anchor.interrupt_switch', 'anchor.peterson_stone', 'anchor.inheritance_toggle']) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const member of ['lumen', 'sable', 'orrery', 'kestrel', 'vesper']) {
      expect(ids.has(`anchor.convoy.${member}`), member).toBe(true);
    }
  });

  it('names a structure for every anchor the registry has no factory for', () => {
    const custom = layout.anchors.filter((anchor) => anchor.kind === 'custom');
    expect(custom.map((anchor) => anchor.structure)).toEqual(['ContentionReadout', 'WideFord', 'InterruptSwitch', 'InheritanceToggle']);
    for (const anchor of custom) expect(anchor.structure?.length ?? 0).toBeGreaterThan(0);
  });

  it('frames every anchor but the readout, which rides in the turnstile shot', () => {
    const ids = new Set(layout.anchors.map((anchor) => anchor.id));
    for (const target of layout.cameraTargets) expect(ids.has(target), target).toBe(true);
    expect(layout.cameraTargets).not.toContain('anchor.contention_readout');
    expect(layout.cameraTargets.length).toBe(layout.anchors.length - 1);
  });

  it('lists as extras exactly the anchors no interaction names', () => {
    const interactionAnchors = new Set(theNarrows.interactions.map((def) => def.anchor));
    const extras = new Set(content.layout.extras);
    for (const anchor of layout.anchors) {
      if (interactionAnchors.has(anchor.id)) expect(extras.has(anchor.id), `${anchor.id} is an interaction anchor`).toBe(false);
      else expect(extras.has(anchor.id), `${anchor.id} is not listed in extras`).toBe(true);
    }
  });

  it('returns null for an anchor it does not carry, rather than throwing', () => {
    const built = stage();
    expect(built.anchor('anchor.nowhere')).toBeNull();
    built.update(0.016, 0);
    built.dispose();
  });

  it('pulls no renderer anywhere under the leg', () => {
    for (const file of ['index.ts', 'stage.ts', 'ledger.ts', 'evaluate.ts', 'crossings.ts', 'interactions.ts', 'populate.ts', 'copy.ts', 'commands.ts', 'events.ts', 'config.ts', 'chapters.ts', 'objectives.ts']) {
      const source = readFileSync(resolve(REPO_ROOT, 'src', 'legs', 'the_narrows', file), 'utf8');
      expect(scanForbiddenImports(source), file).toEqual([]);
    }
  });
});

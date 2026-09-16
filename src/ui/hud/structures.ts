/**
 * The structures an alert may name, pre-flight ruling 6.8. `src/ui` may not
 * value-import `@world`, so the eight names are retyped here and
 * `tests/ui/hud.test.ts` asserts they match `STRUCTURE_NAMES` from the world.
 */
export const HUD_STRUCTURE_NAMES = [
  'FrameVault',
  'ReadyQueueProcession',
  'WaitForRing',
  'PlatterStack',
  'PageOcean',
  'BusSpine',
  'ArchiveShelves',
  'DomainRings',
] as const;

export type HudStructureName = (typeof HUD_STRUCTURE_NAMES)[number];

/** The one non-structure an alert may name: the kernel itself, for a panic. */
export const HUD_KERNEL_NAME = 'Kernel';

export type AlertStructure = HudStructureName | typeof HUD_KERNEL_NAME;

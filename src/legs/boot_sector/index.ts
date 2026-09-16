/**
 * KERNEL TRAIL, leg 0: The Boot Sector. Everything you want is on the other
 * side of a trap.
 *
 * The default export is the frozen `Leg`; `content` is the companion of
 * scope correction section 1. The leg imports nothing from the render
 * layers and keeps no state: every mechanic is derived from the run's
 * decision log.
 */
import type { Leg } from '@game/types';
import type { LegContent } from '../content';
import { chapters } from './chapters';
import { terminalCommands } from './commands';
import { kernelConfig } from './config';
import { codexEntries } from './copy';
import { evaluate } from './evaluate';
import { bootSectorEvents } from './events';
import { handlers, interactions } from './interactions';
import { objectives } from './objectives';
import { populate } from './populate';
import { createStage, layout } from './stage';

const bootSector: Leg = {
  id: 'boot_sector',
  index: 0,
  title: 'The Boot Sector',
  subtitle: 'Everything you want is on the other side of a trap.',
  chapters,
  objectives,
  kernelConfig,
  populate,
  createStage,
  interactions,
  terminalCommands,
  eventTable: bootSectorEvents,
  evaluate,
};

export const content: LegContent = {
  legId: 'boot_sector',
  crossings: [],
  interactions: handlers,
  epitaphs: [],
  codex: codexEntries,
  terminalHandlers: {},
  layout,
};

export default bootSector;

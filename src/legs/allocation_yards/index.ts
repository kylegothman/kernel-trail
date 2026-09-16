/**
 * KERNEL TRAIL, leg 7: THE ALLOCATION YARDS.
 *
 * There is enough room. There is nowhere to stand.
 *
 * The convoy needs five contiguous berths and the yard refuses, with thirty
 * eight percent of it free and visibly dark. First, best and worst fit are
 * literal parking decisions and the leftover strip stays where it was left.
 * Then the yard converts to paged allocation, external fragmentation goes to
 * exactly zero, and internal fragmentation rises from zero in the same frame
 * on two adjacent meters.
 *
 * The leg also plants the run's longest fuse: the executable bit on the data
 * pages. Leaving it set lets a scripted injection run, which kills nothing
 * here and resurfaces at the Arbiter Wall five legs later.
 */
import { layoutStage } from '@legs/layout';
import type { LegContent } from '@legs/content';
import type { Leg } from '@game/types';
import { chapters } from './chapters';
import { objectives } from './objectives';
import { kernelConfig } from './config';
import { populate } from './populate';
import { handlers, interactions } from './interactions';
import { terminalCommands } from './commands';
import { eventTable } from './events';
import { evaluate } from './evaluate';
import { codex, epitaphs } from './copy';
import { layout } from './stage';

const leg: Leg = {
  id: 'allocation_yards',
  index: 7,
  title: 'The Allocation Yards',
  subtitle: 'There is enough room. There is nowhere to stand.',
  chapters,
  objectives,
  kernelConfig,
  populate,
  createStage: () => layoutStage(content.layout),
  interactions,
  terminalCommands,
  eventTable,
  evaluate,
};

export default leg;

/**
 * There are no crossings in the Yards: narrative bible 12.4's crossing
 * schedule has no leg 7 row, and the leg declares no synchronisation
 * primitive for one to take. There are no deferred terminal handlers either;
 * `hyper`, `guest`, `migrate` and `belady` all belong to later legs.
 */
export const content: LegContent = {
  legId: 'allocation_yards',
  crossings: [],
  interactions: handlers,
  epitaphs,
  codex,
  terminalHandlers: {},
  layout,
};

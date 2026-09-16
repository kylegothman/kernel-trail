/**
 * KERNEL TRAIL, leg 4: THE NARROWS.
 *
 * Two feet, one plank. A single-file span over a gap with a ledger post at
 * each end recording who has crossed. Two Programs step on together because
 * nothing stops them, both read the post, both write it, and the number on it
 * is now one less than the number of Programs standing on the far side. The
 * convoy's own manifest is that number.
 *
 * This is the first correctness failure as distinct from a performance one,
 * and it is the leg that explains the Weave's broken tally.
 */
import type { Leg } from '@game/types';
import { registerLegWorkload } from '@game/replay/headlessLegs';
import type { LegContent } from '@legs/content';
import { layoutStage } from '@legs/layout';
import { chapters } from './chapters';
import { terminalCommands } from './commands';
import { kernelConfig } from './config';
import { codex, epitaphs } from './copy';
import { crossings } from './crossings';
import { narrowsEvents } from './events';
import { evaluate } from './evaluate';
import { handlers, interactions } from './interactions';
import { install, programs } from './ledger';
import { objectives } from './objectives';
import { populate } from './populate';
import { layout } from './stage';

export const content: LegContent = {
  legId: 'the_narrows',
  crossings,
  interactions: handlers,
  epitaphs,
  codex,
  terminalHandlers: {},
  layout,
  workload: { programs, install },
};

// The workload has to be in hand before `populate` runs, which is before the
// companion reaches the runner. One line, at import, and `content.workload`
// stays the only copy of it.
registerLegWorkload('the_narrows', content.workload);

const theNarrows: Leg = {
  id: 'the_narrows',
  index: 4,
  title: 'The Narrows',
  subtitle: 'Two feet, one plank.',
  chapters,
  objectives,
  kernelConfig,
  populate,
  createStage: () => layoutStage(layout),
  interactions,
  terminalCommands,
  eventTable: narrowsEvents,
  evaluate,
};

export default theNarrows;

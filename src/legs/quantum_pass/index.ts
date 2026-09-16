/**
 * KERNEL TRAIL: Quantum Pass, leg 3. Someone has to go last.
 *
 * The default export satisfies the frozen `Leg`; `content` is the companion
 * of scope correction section 1. The pass narrows to a single ledge that
 * takes one runner at a time, the policy the convoy carries in is strict
 * priority with no aging, and SABLE has the highest priority number in the
 * convoy. A player who never touches the ledge control watches her starve.
 */
import type { ConvoyMemberId, Tick } from '@kernel/types';
import type { InteractionHandler } from '@game/RunDirector';
import type { Leg, RunState } from '@game/types';
import type { LegContent } from '@legs/content';
import { chapters } from './chapters';
import { terminalCommands } from './commands';
import { kernelConfig } from './config';
import { SUBTITLE, TITLE, codex, epitaphs } from './copy';
import { LEG_ID, UNREMEDIED_KIND, WRONG_REMEDY_KIND, currentScheduler } from './decisions';
import { evaluate } from './evaluate';
import { quantumPassEvents } from './events';
import { INTERACTION_IDS, interactions } from './interactions';
import { objectives } from './objectives';
import { populate } from './populate';
import { createStage, layout } from './stage';

const leg: Leg = {
  id: LEG_ID,
  index: 3,
  title: TITLE,
  subtitle: SUBTITLE,
  chapters,
  objectives,
  kernelConfig,
  populate,
  createStage,
  interactions,
  terminalCommands,
  eventTable: quantumPassEvents,
  evaluate,
};

export default leg;

/**
 * Two records settled late, on the next verb the player reaches for after the
 * pass has answered them. A leg's only mid-leg write is an interaction handler,
 * so every handler settles.
 *
 * The wrong remedy is marked `costly` once the Program it was supposed to save
 * has derezzed, and never `good`, which is the package's rule verbatim. The
 * death itself is recorded separately and marked `fatal`, once, naming the
 * Program: the engine marks a decision fatal only through the crossing runner
 * and this leg has no crossing.
 */
function settle(run: RunState, at: Tick): void {
  const stone = run.tombstones.find((candidate) => candidate.legId === LEG_ID && candidate.reason === 'starvation');
  if (stone === undefined) return;
  for (const record of run.decisions) {
    if (record.legId === LEG_ID && record.kind === WRONG_REMEDY_KIND && record.outcome === 'pending') record.outcome = 'costly';
  }
  if (run.decisions.some((record) => record.legId === LEG_ID && record.kind === UNREMEDIED_KIND)) return;
  run.decisions.push({ tick: at, legId: LEG_ID, kind: UNREMEDIED_KIND, choice: stone.member, outcome: 'fatal', relatedObjective: null });
}

const read: InteractionHandler = (run, at) => { settle(run, at); };

const raiseQuantum: InteractionHandler = (run, at) => {
  settle(run, at);
  if (currentScheduler(run) !== 'priority') return;
  run.decisions.push({ tick: at, legId: LEG_ID, kind: WRONG_REMEDY_KIND, choice: 'quantum raised while priority was in force', outcome: 'pending', relatedObjective: null });
};

const handler = (run: InteractionHandler, target: ConvoyMemberId | null = null): { readonly run: InteractionHandler; readonly target: ConvoyMemberId | null } => ({ run, target });

export const content: LegContent = {
  legId: LEG_ID,
  crossings: [],
  interactions: {
    [INTERACTION_IDS.setPolicy]: handler(read),
    [INTERACTION_IDS.setQuantum]: handler(raiseQuantum),
    [INTERACTION_IDS.setAging]: handler(read),
    [INTERACTION_IDS.setLevels]: handler(read),
    [INTERACTION_IDS.buyEstimates]: handler(read),
    [INTERACTION_IDS.readGantt]: handler(read),
    [INTERACTION_IDS.readWaitCounters]: handler(read),
  },
  epitaphs,
  codex,
  terminalHandlers: {},
  layout,
};

/**
 * The seven player verbs and their companion handlers. A handler reads the
 * record the bus just appended, re-derives the requisition through
 * `reduceRequisition`, moves the goods, and marks the record's outcome. The
 * director charges the interaction's own cost (the 4-cycle trap) before the
 * handler runs, so a refused submission is still charged, and the direct
 * reach costs nothing because no trap was raised.
 */
import type { Tick } from '@kernel/types';
import type { InteractionHandler } from '@game/RunDirector';
import type { DecisionRecord, InteractionDef, RunState } from '@game/types';
import type { LegContent } from '../content';
import { goodsDelta, parseInteractionChoice, reduceRequisition, TRAP_COST } from './windows';

export const ANCHORS = {
  plate: 'anchor.plate',
  cpuPillar: 'anchor.cpu_pillar',
  depot: 'anchor.depot',
  blockStack: 'anchor.block_stack',
  discPlinth: 'anchor.disc_plinth',
  ringStack: 'anchor.ring_stack',
} as const;

export const interactions: readonly InteractionDef[] = [
  {
    id: 'boot.trap_purchase',
    label: 'Submit request',
    description: 'Raise a trap at this window. Costs 4 cycles whatever you ask for.',
    anchor: ANCHORS.depot,
    cost: { cycles: TRAP_COST },
    enabledWhen: (run) => run.resources.cycles >= TRAP_COST,
  },
  {
    id: 'boot.set_mode',
    label: 'Set mode for this request',
    description: 'Choose kernel or user before submitting. The wrong choice returns EPERM and still costs the trap.',
    anchor: ANCHORS.depot,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.batch_request',
    label: 'Add to this submission',
    description: 'Add another item to the pending request. One trap carries as many items as you put in it.',
    anchor: ANCHORS.depot,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.direct_reach',
    label: 'Take the blocks',
    description: 'Reach for the stack directly.',
    anchor: ANCHORS.blockStack,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.inspect_program',
    label: 'Inspect Program',
    description: 'Lock the camera to one Program and read its role, passive, ability and vulnerability.',
    anchor: ANCHORS.plate,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.read_cycle_counter',
    label: 'Read the kernel counter',
    description: 'Lock to the CPU pillar and read how many ticks the kernel has actually held the processor.',
    anchor: ANCHORS.cpuPillar,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.choose_disc',
    label: 'Choose a disc class',
    description: 'Confirms the disc class the run was issued and records which resource it is short of.',
    anchor: ANCHORS.discPlinth,
    cost: {},
    enabledWhen: () => true,
  },
];

/** The record kind that ends a zero-segment leg (pre-flight ruling 1). */
export const LEG_DONE_KIND = 'leg_done';

const LEDGER_KEYS = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;

/** The interaction record the bus appended for this verb, which is always the last record. */
function currentRecord(run: RunState, id: string): DecisionRecord | null {
  const record = run.decisions.at(-1);
  if (record === undefined || record.kind !== 'interaction') return null;
  return parseInteractionChoice(record.choice)?.id === id ? record : null;
}

const trapPurchase: InteractionHandler = (run) => {
  const record = currentRecord(run, 'boot.trap_purchase');
  if (record === null) return;
  const state = reduceRequisition(run.decisions, run.discClass, run.difficulty);
  const submission = state.submissions.at(-1);
  if (submission === undefined || submission.decisionIndex !== run.decisions.length - 1) return;
  if (submission.errno !== null) {
    record.outcome = 'costly';
    return;
  }
  const delta = goodsDelta(submission.items, run.difficulty);
  const short = LEDGER_KEYS.some((key) => run.resources[key] + (delta[key] ?? 0) < 0);
  if (short) {
    // ENOMEM: the resource exists and there is not enough of it. The trap was still charged.
    record.outcome = 'costly';
    return;
  }
  for (const key of LEDGER_KEYS) run.resources[key] += delta[key] ?? 0;
  record.outcome = 'good';
};

const markParsed = (id: string, valid: (argument: string | null, anchor: string) => boolean): InteractionHandler => (run) => {
  const record = currentRecord(run, id);
  if (record === null) return;
  const parsed = parseInteractionChoice(record.choice);
  if (parsed === null || !valid(parsed.argument, parsed.anchor)) record.outcome = 'costly';
};

const isWindowAnchor = (anchor: string): boolean => anchor.startsWith('anchor.win.');

/** EPERM, and no charge: no trap was raised, which is the control condition for the trap cost. */
const directReach: InteractionHandler = (run) => {
  const record = currentRecord(run, 'boot.direct_reach');
  if (record !== null) record.outcome = 'costly';
};

const chooseDisc: InteractionHandler = (run, at: Tick) => {
  const record = currentRecord(run, 'boot.choose_disc');
  if (record === null) return;
  const state = reduceRequisition(run.decisions, run.discClass, run.difficulty);
  const gate = state.gate;
  record.outcome = gate !== null && gate.correct ? 'good' : 'costly';
  // The gate closes the requisition: the record a zero-segment leg completes on, pushed the way a hand-off record is, once.
  if (run.decisions.some((existing) => existing.legId === 'boot_sector' && existing.kind === LEG_DONE_KIND)) return;
  run.decisions.push({ tick: at, legId: 'boot_sector', kind: LEG_DONE_KIND, choice: gate?.answer ?? '', outcome: 'pending', relatedObjective: null });
};

export const handlers: LegContent['interactions'] = {
  'boot.trap_purchase': { run: trapPurchase, target: null },
  'boot.set_mode': { run: markParsed('boot.set_mode', (argument, anchor) => isWindowAnchor(anchor) && (argument === 'kernel' || argument === 'user')), target: null },
  'boot.batch_request': { run: markParsed('boot.batch_request', (argument, anchor) => isWindowAnchor(anchor) && (argument === null || /^-?\d+$/.test(argument))), target: null },
  'boot.direct_reach': { run: directReach, target: null },
  'boot.inspect_program': { run: () => undefined, target: null },
  'boot.read_cycle_counter': { run: () => undefined, target: null },
  'boot.choose_disc': { run: chooseDisc, target: null },
};

/**
 * KERNEL TRAIL: the Allocation Yards' player verbs and their handlers.
 *
 * The frozen `InteractionDef` carries no payload, so a verb that would take an
 * argument is split into one id per value (pre-flight ruling 6): the page size
 * dial is an up and a down, and the route fork is two routes. The allocation
 * strategy is not a verb here at all, because `set_allocation` is already on
 * the command bus and every surface reaches it there.
 *
 * Every handler settles the leg's outstanding records first (protection.ts),
 * because an interaction is the only moment a leg may write to the run.
 */
import type { Tick } from '@kernel/types';
import type { InteractionDef, RunState } from '@game/types';
import type { InteractionHandler } from '@game/RunDirector';
import { findDecision, injectionHasRun, record, settle } from './protection';

export const COMPACTION_CYCLES = 20;

const alive = (run: Readonly<RunState>, id: string): boolean =>
  run.convoy.some((member) => member.id === id && member.status !== 'derezzed');

export const interactions: readonly InteractionDef[] = [
  {
    id: 'yards.compact',
    label: 'Buy a compaction pass',
    description: 'Slide every occupied run together. It works, it stops every process that owns memory for the duration, and it must update every base register.',
    anchor: 'anchor.compaction_crew',
    cost: { cycles: COMPACTION_CYCLES },
    enabledWhen: (run) => run.resources.cycles >= COMPACTION_CYCLES,
  },
  {
    id: 'yards.convert_to_paging',
    label: 'Convert the yard to paged allocation',
    description: 'Any free frame fits any page. Watch both meters when you commit this.',
    anchor: 'anchor.paging_gate',
    cost: { cycles: 40, bandwidth: 6 },
    enabledWhen: (run) => run.resources.cycles >= 40 && run.resources.bandwidth >= 6,
  },
  {
    id: 'yards.page_size_up',
    label: 'Turn the page size up',
    description: 'Larger pages mean smaller page tables and more waste inside the last frame of each Program.',
    anchor: 'anchor.page_size_dial',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'yards.page_size_down',
    label: 'Turn the page size down',
    description: 'Smaller pages waste less inside the last frame and cost more rows on the index board.',
    anchor: 'anchor.page_size_dial',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'yards.clear_executable',
    label: 'Clear the executable bit on the data pages',
    description: 'Read, write and execute, per page range, enforced by the hardware on every access.',
    anchor: 'anchor.protection_bench',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'yards.route_contiguous',
    label: 'Take the contiguous route',
    description: 'Eight pages in order, the same distance as the other road.',
    anchor: 'anchor.route_fork',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'yards.route_scattered',
    label: 'Take the scattered route',
    description: 'The same distance, striding across four hundred pages.',
    anchor: 'anchor.route_fork',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'yards.buy_tlb_entries',
    label: 'Buy TLB entries',
    description: 'More entries cover more pages. It helps a little and it costs real money.',
    anchor: 'anchor.tlb_console',
    cost: { cycles: 90, blocks: 20 },
    enabledWhen: (run) => run.resources.cycles >= 90 && run.resources.blocks >= 20,
  },
  {
    id: 'yards.vesper_remap',
    label: 'VESPER: remap',
    description: 'Rebuild one page table with optimal locality.',
    anchor: 'anchor.index_board',
    cost: { bandwidth: 8 },
    enabledWhen: (run) => alive(run, 'vesper') && run.resources.bandwidth >= 8,
  },
  {
    id: 'yards.answer_translation',
    label: 'Answer the translation gate',
    description: 'Give the frame number and the offset. The gate accepts one attempt.',
    anchor: 'anchor.translation_gate',
    cost: {},
    enabledWhen: () => true,
  },
];

export const INTERACTION_IDS: readonly string[] = interactions.map((def) => def.id);

/**
 * Every declared verb needs a companion entry or the director refuses it as
 * unavailable. None of them costs integrity, so every target is null.
 */
export const handlers: Readonly<Record<string, { readonly run: InteractionHandler; readonly target: null }>> =
  Object.fromEntries(interactions.map((def) => [def.id, { run: handlerFor(def.id), target: null }]));

function handlerFor(id: string): InteractionHandler {
  if (id === 'yards.clear_executable') {
    return (run: RunState, at: Tick): void => {
      settle(run, at);
      // The bench only helps before the injection. Afterwards `settle` has
      // already written that the bit was left set, and nothing undoes that.
      if (findDecision(run, 'executable_bit') === undefined && !injectionHasRun(run)) {
        record(run, at, 'executable_bit', 'cleared', 'pending', 'obj.allocation_yards.protection_bits');
      }
    };
  }
  return (run: RunState, at: Tick): void => { settle(run, at); };
}

/** KERNEL TRAIL: the Allocation Yards' learning objectives (curriculum map, leg 7). */
import type { LearningObjective } from '@game/types';
import { section } from './chapters';

export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.allocation_yards.strategy_choice',
    statement: 'Selects an allocation strategy that places every Program in the convoy and leaves external fragmentation under 12 percent of total yard space at leg end.',
    chapter: section('9.2.2', '9.2.3'),
    assessedBy: 'outcome',
  },
  {
    id: 'obj.allocation_yards.diagnose_fragmentation',
    statement: 'Distinguishes an allocation failure caused by fragmentation from one caused by genuine exhaustion using free -f, and spends cycles on compaction only in the first case.',
    chapter: section('9.2.3'),
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.allocation_yards.paging_trade',
    statement: 'Converts the yard to paged allocation and reports external fragmentation at exactly zero while internal fragmentation rises to no more than half a frame per Program.',
    chapter: section('9.3.1'),
    assessedBy: 'outcome',
  },
  {
    id: 'obj.allocation_yards.translate_address',
    statement: 'Reads a page table with pagetable and translates a given logical address to the correct frame number and offset on the first attempt at the translation gate.',
    chapter: section('9.3.1', '9.3.2'),
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.allocation_yards.locality_over_hardware',
    statement: 'Raises the TLB hit rate above 85 percent by choosing the contiguous access route over the scattered one, without buying additional TLB entries.',
    chapter: section('9.3.2'),
    assessedBy: 'decision',
  },
  {
    id: 'obj.allocation_yards.protection_bits',
    statement: 'Clears the executable bit on the data pages so the scripted write-then-execute attempt raises a protection fault instead of running.',
    chapter: section('9.3.3'),
    assessedBy: 'decision',
  },
  {
    id: 'obj.allocation_yards.page_size_tradeoff',
    statement: 'Chooses a page size that holds each Program page table under 64 entries while keeping internal fragmentation under 8 percent of allocated memory.',
    chapter: section('9.3.1', '9.4.1'),
    assessedBy: 'decision',
  },
];

export const OBJECTIVE_IDS: readonly string[] = objectives.map((objective) => objective.id);

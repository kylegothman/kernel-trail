/**
 * KERNEL TRAIL: the Allocation Yards' authored text. The tombstones are the
 * one licensed comic register in the game; everything else here reports
 * measurements and stops talking (narrative bible 2.1).
 */
import type { EpitaphTemplate } from '@game/convoy/derezz';
import type { CodexEntry } from '@game/codexTypes';
import { AFFLICTION_TABLE } from '@game/afflictions/table';
import { section } from './chapters';

/**
 * This leg's own stones. `sharedEpitaphSource` serves these alone for a reason
 * any of them names, so a pinned stone needs unpinned company for the same
 * reason or `derezz` throws on an empty candidate list (scope correction 16).
 * Two of the three are unpinned for exactly that reason.
 */
export const epitaphs: readonly EpitaphTemplate[] = [
  {
    id: 'ep.yards.forty_one_pieces',
    reason: 'out_of_memory',
    legId: 'allocation_yards',
    member: 'vesper',
    inscription: 'HERE LIES VESPER, FORTY-ONE PIECES',
    cause: 'External fragmentation. Ninety-seven slabs free, largest run nine, request twelve. The yard was never short of room.',
    codexEntry: 'codex.fragmentation',
  },
  {
    id: 'ep.yards.no_berth',
    reason: 'out_of_memory',
    legId: 'allocation_yards',
    inscription: 'HERE LIES {NAME}, NO BERTH',
    cause: 'Refused a contiguous run, and refused the same run thirty ticks later. A Program that cannot be placed cannot run.',
    codexEntry: 'codex.fragmentation',
  },
  {
    id: 'ep.yards.more_pieces',
    reason: 'out_of_memory',
    legId: 'allocation_yards',
    inscription: 'HERE LIES {NAME}, BOUGHT TWENTY-FIVE MORE PIECES',
    cause: 'Quota purchased against a failure whose reason was shape. Adding free space to a fragmented free list adds pieces, not runs.',
    codexEntry: 'codex.contiguous_allocation',
  },
];

const base = {
  workedExample: null,
  counterfactual: null,
  remedy: null,
  remedyVisibility: 'never',
} as const;

/**
 * The eight entries of the curriculum map's "Codex entries unlocked", authored
 * in full. Three of the eight conditions have no exact arm and are expressed
 * with the nearest one; each carries a comment saying what was approximated
 * (scope correction section 5).
 */
export const codex: readonly CodexEntry[] = [
  {
    ...base,
    id: 'codex.address_binding',
    title: 'Address Binding',
    chapter: section('9.1.1', '9.1.2', '9.1.3'),
    concept: 'A program names addresses; the machine names locations. Binding is the moment one becomes the other, and it can happen when the code is compiled, when it is loaded, or on every access while it runs. Compile-time binding fixes the program to one place in memory forever. Execution-time binding is the only one that lets the yard move a Program after it has been placed, which is why compaction is possible at all.',
    // Approximation: the arm cannot see a base register assignment, so it fires
    // on the first allocation, which is the tick the base register is written.
    unlock: { kind: 'event', type: 'memory.allocated' },
    related: ['codex.logical_vs_physical', 'codex.contiguous_allocation'],
    commands: ['free', 'frag'],
    epitaphs: [],
  },
  {
    ...base,
    id: 'codex.logical_vs_physical',
    title: 'Logical and Physical Addresses',
    chapter: section('9.1.2', '9.3.1'),
    concept: 'The address a process computes is not the address the memory sees. A logical address is an offset into an address space that starts at zero for every process; the memory management unit turns it into a physical one on every access. The process never learns the physical number and cannot be written to depend on it. That separation is what lets two processes both believe they own address zero.',
    unlock: { kind: 'command', name: 'pagetable', flag: '--translate' },
    related: ['codex.paging', 'codex.address_binding'],
    commands: ['pagetable'],
    epitaphs: [],
  },
  {
    ...base,
    id: 'codex.contiguous_allocation',
    title: 'Contiguous Allocation',
    chapter: section('9.2.1', '9.2.2', '9.2.3'),
    concept: 'Under contiguous allocation a process gets one unbroken run of memory, described by a base register and a limit register, and every access is checked against both. The allocator picks which free run to cut from: first fit takes the first that is large enough, best fit takes the tightest, worst fit takes the largest. On most sequences first fit and best fit land close together and worst fit does badly, because leaving the largest remaining hole leaves the most holes.',
    // Approximation: no terminal verb sets the strategy, so the arm fires on the
    // first `frag`, which is the instrument the yard office is read through.
    unlock: { kind: 'command', name: 'frag' },
    related: ['codex.fragmentation', 'codex.address_binding', 'codex.allocation_methods'],
    commands: ['frag', 'free'],
    epitaphs: ['ep.yards.more_pieces'],
  },
  {
    ...base,
    id: 'codex.fragmentation',
    title: 'Fragmentation',
    chapter: section('9.2.3', '9.3.1'),
    concept: 'External fragmentation is free memory that exists and cannot be used, because it is split into runs smaller than the request. Internal fragmentation is memory that was handed out in a fixed unit larger than the request, and the remainder inside the unit is unreachable. They are different problems with opposite cures: compaction or paging for the first, smaller units for the second. An out-of-memory failure with plenty of free memory is not a contradiction, and the reason field on the failure event is the whole answer.',
    unlock: { kind: 'event', type: 'memory.allocation_failed' },
    remedy: { ...AFFLICTION_TABLE.fragmented.remedy },
    remedyVisibility: 'on_unlock',
    related: ['codex.contiguous_allocation', 'codex.paging', 'codex.allocation_methods'],
    commands: ['free', 'frag'],
    epitaphs: ['ep.yards.forty_one_pieces', 'ep.yards.no_berth'],
  },
  {
    ...base,
    id: 'codex.paging',
    title: 'Paging',
    chapter: section('9.3.1'),
    concept: 'Paging cuts the address space into fixed-size pages and physical memory into frames of the same size, and keeps a table mapping one to the other. The mapping is arbitrary, so an address space can be contiguous while the memory holding it is scattered anywhere. That is why paging makes external fragmentation impossible: any free frame fits any page. What it does not remove is internal fragmentation, which moves inside the last frame of every process and averages half a page each.',
    // Approximation: the conversion is an interaction rather than an event, so
    // the arm fires on the objective the conversion is assessed by.
    unlock: { kind: 'objective', id: 'obj.allocation_yards.paging_trade' },
    related: ['codex.fragmentation', 'codex.tlb', 'codex.page_table_structure'],
    commands: ['pagetable', 'frag'],
    epitaphs: [],
  },
  {
    ...base,
    id: 'codex.tlb',
    title: 'The Translation Lookaside Buffer',
    chapter: section('9.3.2'),
    concept: 'Paging costs two memory accesses for every one the program asked for: one to read the page table, one to read the data. The translation lookaside buffer is a small associative cache of recent mappings that makes the first one free when it hits. Effective access time is h times m plus one minus h times two m, so a hit rate of 0.99 costs almost nothing and a hit rate of 0.5 spends half the memory bandwidth on translation. The hit rate is a property of the access pattern, not of the hardware.',
    unlock: { kind: 'command', name: 'tlb', flag: '--stats' },
    related: ['codex.paging', 'codex.logical_vs_physical'],
    commands: ['tlb', 'pagetable'],
    epitaphs: [],
  },
  {
    ...base,
    id: 'codex.page_protection',
    title: 'Page Protection Bits',
    chapter: section('9.3.3'),
    concept: 'Every page table entry carries a readable, a writable and an executable bit, and the memory management unit checks them on every access. They are worth something precisely because no code you write is involved: a page marked non-executable cannot be executed even by the process that owns it and wants to. A software check can be skipped by whatever managed to reach the page in the first place. A hardware check cannot.',
    unlock: { kind: 'command', name: 'pagetable', flag: '--bits' },
    related: ['codex.paging', 'codex.protection_rings', 'codex.code_injection'],
    commands: ['pagetable'],
    epitaphs: [],
  },
  {
    ...base,
    id: 'codex.page_table_structure',
    title: 'Page Table Structure',
    chapter: section('9.3.4', '9.4.1', '9.4.3'),
    concept: 'A thirty-two bit address space with four kilobyte pages needs a table of a million entries per process, which is too large to hold contiguously. Hierarchical tables page the table itself, so only the parts in use are resident, at the cost of one extra memory access per level. Inverted tables keep one entry per physical frame instead, which bounds the size by memory rather than by address space and makes lookup a search. Page size is the dial underneath all of it: larger pages mean fewer rows and more waste.',
    // Approximation: the dial is an interaction rather than an event, so the arm
    // fires on the objective the page size decision is assessed by.
    unlock: { kind: 'objective', id: 'obj.allocation_yards.page_size_tradeoff' },
    related: ['codex.paging', 'codex.fragmentation'],
    commands: ['pagetable'],
    epitaphs: [],
  },
];

export const CODEX_IDS: readonly string[] = codex.map((entry) => entry.id);

/**
 * Codex cross-links this leg registers into entries another leg owns. Both
 * halves of each pair are named in `00-LEG-BUILD-ORDER.md`; the other side
 * registers its own, and the report enumerates any that are still one-sided.
 */
export const PENDING_CROSS_LINKS: readonly string[] = [
  'codex.allocation_methods',
  'codex.protection_rings',
  'codex.code_injection',
];
